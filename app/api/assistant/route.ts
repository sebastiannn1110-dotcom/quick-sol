import { NextResponse } from "next/server";
import {
  answerAssistantQuestion,
  AssistantConfigError,
  AssistantRequestError
} from "@/lib/ai/assistantCore";
import {
  appendOwnedMessage,
  ConversationMemoryError,
  loadOwnedConversation,
  type AiMessageSourceType,
  type SafeHistoryMessage
} from "@/lib/ai/conversation-memory";
import { AssistantToolRequestError } from "@/lib/ai/database-tools";
import { detectAssistantLanguage } from "@/lib/ai/language-detection";
import { assistantMessage } from "@/lib/ai/messages";
import { parseAssistantRequest } from "@/lib/ai/request-schema";
import {
  logSafeAiEvent,
  safeAiErrorCode,
  sanitizeQuestionForLogs
} from "@/lib/ai/safe-logging";
import { getAuthContext } from "@/lib/auth/context";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      ...headers
    }
  });
}

function publicError(
  language: "es" | "en" | "zh",
  status: number,
  code: string,
  message?: string
) {
  const key =
    status === 403 ? "inactive" :
      status === 429 ? "rateLimit" :
        status === 502 ? "providerFailed" :
          status === 503 ? "providerMissing" :
            status === 504 ? "timeout" :
              "malformed";
  return json({ error: message || assistantMessage(language, key), code }, status);
}

function memorySourceType(value: string): AiMessageSourceType {
  if (value === "opportunity_finder") return "opportunity_finder";
  if (value === "stock_needs") return "stock_needs";
  if (value === "upload_metadata") return "latest_upload";
  if (value === "authorized_database") return "authorized_database";
  return "assistant";
}

function memoryErrorStatus(error: ConversationMemoryError) {
  if (error.code === "not_found") return 404;
  if (error.code === "invalid_content") return 422;
  if (error.code === "migration_required") return 503;
  return 502;
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const parsed = await parseAssistantRequest(request);
  if (!parsed.ok) {
    await logSafeAiEvent(context, {
      action: "ai_text_rejected",
      status: "failed",
      metadata: {
        channel: "text",
        state: parsed.code,
        errorCode: parsed.code
      }
    });
    return publicError("es", parsed.status, parsed.code);
  }

  const { message, jobId, conversationId } = parsed.data;
  const language = detectAssistantLanguage(message, parsed.data.language);
  const questionMetrics = sanitizeQuestionForLogs(message);

  const rate = await checkPersistentRateLimit({
    action: "assistant",
    identifier: context.profile.id,
    limit: 30,
    windowSeconds: 15 * 60,
    blockSeconds: 5 * 60
  });
  if (!rate.allowed) {
    await logSafeAiEvent(context, {
      action: "ai_rate_limited",
      status: "failed",
      metadata: {
        language,
        channel: "text",
        errorCode: "RATE_LIMITED",
        ...questionMetrics
      }
    });
    return json(
      { error: assistantMessage(language, "rateLimit"), code: "RATE_LIMITED" },
      429,
      { "Retry-After": `${Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))}` }
    );
  }

  let history: SafeHistoryMessage[] = [];
  if (conversationId) {
    if (!context.supabase) return publicError(language, 503, "MEMORY_UNAVAILABLE");
    try {
      history = (await loadOwnedConversation(
        context.supabase,
        context.profile.id,
        conversationId
      )).safeHistory;
    } catch (error) {
      if (error instanceof ConversationMemoryError) {
        return publicError(
          language,
          memoryErrorStatus(error),
          `MEMORY_${error.code.toUpperCase()}`
        );
      }
      return publicError(language, 502, "MEMORY_LOAD_FAILED");
    }
  }

  const startedAt = performance.now();
  await logSafeAiEvent(context, {
    action: "ai_text_started",
    status: "started",
    metadata: {
      language,
      channel: "text",
      ...questionMetrics
    }
  });

  try {
    const result = await answerAssistantQuestion({
      context,
      message,
      language,
      channel: "text",
      jobId,
      history,
      signal: request.signal
    });

    if (conversationId) {
      if (!context.supabase) return publicError(language, 503, "MEMORY_UNAVAILABLE");
      try {
        await appendOwnedMessage(context.supabase, context.profile.id, conversationId, {
          role: "user",
          content: message,
          language,
          sourceType: "user"
        });
        await appendOwnedMessage(context.supabase, context.profile.id, conversationId, {
          role: "assistant",
          content: result.answerText,
          language,
          intent: result.intent,
          sourceType: memorySourceType(result.sourceType)
        });
      } catch (error) {
        if (error instanceof ConversationMemoryError) {
          return publicError(
            language,
            memoryErrorStatus(error),
            `MEMORY_${error.code.toUpperCase()}`
          );
        }
        return publicError(language, 502, "MEMORY_WRITE_FAILED");
      }
    }

    await logSafeAiEvent(context, {
      action: "ai_text_done",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: {
        language,
        channel: "text",
        intent: result.intent,
        tool: result.tool,
        provider: result.generatedWithAi ? "openai" : "deterministic",
        fallbackUsed: result.fallbackUsed,
        ...questionMetrics
      }
    });
    return json(result);
  } catch (error) {
    const status =
      error instanceof AssistantRequestError ||
      error instanceof AssistantConfigError ||
      error instanceof AssistantToolRequestError
        ? error.status
        : 502;
    const code =
      error instanceof AssistantRequestError ||
      error instanceof AssistantToolRequestError
        ? error.code
        : error instanceof AssistantConfigError
          ? error.code
          : safeAiErrorCode(error).toUpperCase();
    await logSafeAiEvent(context, {
      action: "ai_text_failed",
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error,
      metadata: {
        language,
        channel: "text",
        errorCode: code,
        timeout: status === 504,
        ...questionMetrics
      }
    });
    return publicError(
      language,
      status,
      code,
      error instanceof AssistantRequestError ||
      error instanceof AssistantToolRequestError
        ? error.message
        : undefined
    );
  }
}
