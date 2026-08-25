import { NextResponse } from "next/server";
import { answerAssistantQuestion } from "@/lib/ai/assistantCore";
import {
  appendOwnedMessage,
  loadOwnedConversation,
  type AiMessageSourceType,
  type SafeHistoryMessage
} from "@/lib/ai/conversation-memory";
import { getAuthContext } from "@/lib/auth/context";
import { detectAssistantLanguage } from "@/lib/ai/language-detection";
import { assistantMessage } from "@/lib/ai/messages";
import { parseAssistantRequest } from "@/lib/ai/request-schema";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProgressStage =
  | "validating"
  | "searching"
  | "processing"
  | "generating"
  | "completed";

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const INTERNAL_PATH_PATTERN =
  /(?:\/api\/|\/storage\/|\/uploads?\/)[a-z0-9_./?=&%-]*/gi;

function safePublicText(value: string) {
  return value
    .replace(UUID_PATTERN, "[redacted-id]")
    .replace(INTERNAL_PATH_PATTERN, "[internal-path]");
}

function privateJson(body: unknown, status: number) {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

function sourceMetadata(sourceType: string | undefined, generatedWithAi: boolean) {
  if (sourceType === "opportunity_finder") {
    return {
      source: "Opportunity Finder",
      sourceType: "opportunity_finder" as const,
      basedOnData: true,
      generatedWithAi
    };
  }
  if (sourceType === "stock_needs") {
    return {
      source: "Stock Needs",
      sourceType: "stock_needs" as const,
      basedOnData: true,
      generatedWithAi
    };
  }
  if (sourceType === "upload_metadata") {
    return {
      source: "Latest upload",
      sourceType: "latest_upload" as const,
      basedOnData: true,
      generatedWithAi
    };
  }
  if (sourceType && sourceType !== "assistant_policy") {
    return {
      source: "Authorized database",
      sourceType: "authorized_database" as const,
      basedOnData: true,
      generatedWithAi
    };
  }
  return {
    source: null,
    sourceType: "assistant" as const,
    basedOnData: false,
    generatedWithAi
  };
}

function sseEvent(event: "progress" | "completed" | "error", data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function abortError() {
  return new DOMException("Request aborted.", "AbortError");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError());
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    })
  ]);
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const parsed = await parseAssistantRequest(request);
  if (!parsed.ok) return privateJson({ error: "Invalid assistant request.", code: parsed.code }, parsed.status);
  if (parsed.data.conversationId && !context.supabase) {
    return privateJson({ error: "Assistant history is unavailable." }, 503);
  }

  const rate = await checkPersistentRateLimit({
    action: "assistant_stream",
    identifier: context.profile.id,
    limit: 30,
    windowSeconds: 15 * 60,
    blockSeconds: 5 * 60
  });
  const language = detectAssistantLanguage(parsed.data.message, parsed.data.language);
  if (!rate.allowed) {
    const response = privateJson({
      error: assistantMessage(language, "rateLimit"),
      code: "RATE_LIMITED"
    }, 429);
    response.headers.set(
      "Retry-After",
      `${Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))}`
    );
    return response;
  }

  const { message, conversationId, jobId } = parsed.data;
  const encoder = new TextEncoder();
  const localAbort = new AbortController();
  const abort = () => localAbort.abort();
  request.signal.addEventListener("abort", abort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (
        event: "progress" | "completed" | "error",
        payload: Record<string, unknown>
      ) => {
        if (closed || localAbort.signal.aborted) return;
        controller.enqueue(encoder.encode(sseEvent(event, payload)));
      };
      const progress = (stage: ProgressStage) => send("progress", { stage });

      try {
        progress("validating");
        let safeHistory: SafeHistoryMessage[] = [];
        if (conversationId) {
          safeHistory = (await raceWithAbort(
            loadOwnedConversation(context.supabase!, context.profile.id, conversationId),
            localAbort.signal
          )).safeHistory;
          await raceWithAbort(
            appendOwnedMessage(context.supabase!, context.profile.id, conversationId, {
              role: "user",
              content: message,
              language,
              sourceType: "user"
            }),
            localAbort.signal
          );
        }

        progress("searching");
        progress("processing");
        progress("generating");
        const result = await raceWithAbort(
          answerAssistantQuestion({
            context,
            message,
            language,
            channel: "text",
            jobId,
            history: safeHistory,
            signal: localAbort.signal
          }),
          localAbort.signal
        );
        const metadata = sourceMetadata(result.sourceType, result.generatedWithAi);
        const answerText = safePublicText(result.answerText);
        const speechText = safePublicText(result.speechText);
        if (conversationId) {
          await raceWithAbort(
            appendOwnedMessage(context.supabase!, context.profile.id, conversationId, {
              role: "assistant",
              content: answerText,
              language,
              intent: result.intent,
              sourceType: metadata.sourceType as AiMessageSourceType
            }),
            localAbort.signal
          );
        }

        progress("completed");
        send("completed", {
          stage: "completed",
          answer: answerText,
          speechText,
          timings: result.timings,
          metadata: {
            basedOnData: metadata.basedOnData,
            generatedWithAi: metadata.generatedWithAi,
            source: metadata.source
          }
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          send("error", {
            stage: "completed",
            error: "The assistant could not complete this request."
          });
        }
      } finally {
        closed = true;
        request.signal.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // The browser may already have cancelled the stream.
        }
      }
    },
    cancel() {
      localAbort.abort();
      request.signal.removeEventListener("abort", abort);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
