import OpenAI from "openai";
import type { AuthContext } from "@/lib/auth/context";
import { languageName, type AssistantLanguage } from "@/lib/ai/language-detection";
import { routeAssistantDatabaseQuery } from "@/lib/ai/ai-query-router";
import {
  SAFE_ASSISTANT_FALLBACK,
  TIMEOUT_ASSISTANT_FALLBACK,
  normalizeSpeechResponse,
  normalizeTextResponse
} from "@/lib/ai/response-normalizer";
import { logger } from "@/lib/logger/logger";

export type { AssistantLanguage } from "@/lib/ai/language-detection";
export type AssistantChannel = "text" | "voice";

export class AssistantConfigError extends Error {
  status = 503;
}

function getOpenAIKey() {
  return process.env.OPEN_IA || process.env.OPENAI_API_KEY || "";
}

function noDataMessage(language: AssistantLanguage) {
  if (language === "zh") return "我没有在数据库中找到足够的信息来回答这个问题。";
  if (language === "en") return "I did not find enough information in the database to answer that.";
  return "No encontre informacion suficiente en la base de datos para responder eso.";
}

function permissionMessage(language: AssistantLanguage) {
  if (language === "zh") return "你没有权限查看该信息。";
  if (language === "en") return "You do not have permission to view that information.";
  return "No tienes permisos para ver esa informacion.";
}

function safeFallbackMessage(language: AssistantLanguage) {
  if (language === "en") return "I could not get every detail right now, but I can show the available summary.";
  if (language === "zh") return "我现在无法获取所有细节，但可以显示可用摘要。";
  return SAFE_ASSISTANT_FALLBACK;
}

function timeoutFallbackMessage(language: AssistantLanguage) {
  if (language === "en") return "The query took too long. I am showing the available summary, and you can try a more specific question.";
  if (language === "zh") return "查询时间过长。我会显示可用摘要，你也可以尝试更具体的问题。";
  return TIMEOUT_ASSISTANT_FALLBACK;
}

function isDatabaseTimeout(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const text = [record.code, record.message, record.details, record.hint, String(error ?? "")].filter(Boolean).join(" ");
  return /57014|statement timeout|timeout/i.test(text);
}

function compact(value: unknown, max = 14_000) {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > max ? `${serialized.slice(0, max)}\n[resultado truncado]` : serialized;
}

function publicToolResult(toolResult: Awaited<ReturnType<typeof routeAssistantDatabaseQuery>>["toolResult"]) {
  if (!toolResult) return null;
  return {
    ok: toolResult.ok,
    tool: toolResult.tool,
    scope: toolResult.scope,
    total: toolResult.total,
    summary: toolResult.summary,
    warning: toolResult.warning
  };
}

function buildAssistantResult(input: {
  intent: string;
  tool: string | null;
  rawAnswer: string;
  channel: AssistantChannel;
  dataLookupMs: number;
  llmMs: number;
  startedAt: number;
  toolResult: Awaited<ReturnType<typeof routeAssistantDatabaseQuery>>["toolResult"];
  language: AssistantLanguage;
}) {
  const answerText = normalizeTextResponse(input.rawAnswer, { fallback: safeFallbackMessage(input.language) });
  return {
    intent: input.intent,
    tool: input.tool,
    answer: answerText,
    answerText,
    speechText: normalizeSpeechResponse(answerText),
    channel: input.channel,
    toolResult: publicToolResult(input.toolResult),
    timings: {
      dataLookupMs: input.dataLookupMs,
      llmMs: input.llmMs,
      totalMs: Math.round(performance.now() - input.startedAt)
    }
  };
}

async function logAiTiming(
  context: AuthContext,
  action: string,
  message: string,
  status: "started" | "completed" | "failed",
  metadata?: Record<string, unknown>,
  durationMs?: number,
  error?: unknown
) {
  await logger[status === "failed" ? "warn" : "info"]({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "ai",
    action,
    message,
    status,
    durationMs,
    metadata,
    error
  });
}

export async function answerAssistantQuestion({
  context,
  message,
  language,
  channel = "text"
}: {
  context: AuthContext;
  message: string;
  language: AssistantLanguage;
  channel?: AssistantChannel;
}) {
  const startedAt = performance.now();
  const dataStartedAt = performance.now();
  await logAiTiming(context, "ai_data_lookup_started", "AI controlled data lookup started.", "started", { channel, language });
  let routed: Awaited<ReturnType<typeof routeAssistantDatabaseQuery>>;
  try {
    routed = await routeAssistantDatabaseQuery(context, message);
  } catch (error) {
    const dataLookupMs = Math.round(performance.now() - dataStartedAt);
    const timeout = isDatabaseTimeout(error);
    await logAiTiming(
      context,
      timeout ? "ai_timeout" : "ai_context_limited",
      timeout ? "AI data lookup timed out." : "AI data lookup failed and returned a limited response.",
      "failed",
      { channel, language },
      dataLookupMs,
      error
    );
    await logAiTiming(context, "ai_safe_response_returned", "AI safe response returned to user.", "completed", { channel, language, timeout });
    return buildAssistantResult({
      intent: timeout ? "database_timeout" : "safe_fallback",
      tool: null,
      rawAnswer: timeout ? timeoutFallbackMessage(language) : safeFallbackMessage(language),
      channel,
      dataLookupMs,
      llmMs: 0,
      startedAt,
      toolResult: null,
      language
    });
  }
  const dataLookupMs = Math.round(performance.now() - dataStartedAt);
  await logAiTiming(context, "ai_data_lookup_done", "AI controlled data lookup completed.", "completed", {
    channel,
    language,
    permissionDenied: routed.permissionDenied,
    tool: routed.toolResult?.tool,
    scope: routed.toolResult?.scope,
    empty: routed.toolResult?.empty
  }, dataLookupMs);

  if (routed.permissionDenied) {
    return buildAssistantResult({
      intent: "permission_denied",
      tool: null,
      rawAnswer: permissionMessage(language),
      channel,
      dataLookupMs,
      llmMs: 0,
      startedAt,
      toolResult: null,
      language
    });
  }

  if (!routed.toolResult || routed.toolResult.empty) {
    return buildAssistantResult({
      intent: routed.toolResult?.tool ?? "no_result",
      tool: routed.toolResult?.tool ?? null,
      rawAnswer: noDataMessage(language),
      channel,
      dataLookupMs,
      llmMs: 0,
      startedAt,
      toolResult: routed.toolResult,
      language
    });
  }

  const apiKey = getOpenAIKey();
  if (!apiKey || routed.toolResult.deterministic) {
    if (routed.toolResult.deterministic) {
      await logAiTiming(context, "ai_fallback_used", "AI deterministic response returned without LLM.", "completed", {
        channel,
        language,
        tool: routed.toolResult.tool
      });
    }
    return buildAssistantResult({
      intent: routed.toolResult.tool,
      tool: routed.toolResult.tool,
      rawAnswer: routed.toolResult.summary,
      channel,
      dataLookupMs,
      llmMs: 0,
      startedAt,
      toolResult: routed.toolResult,
      language
    });
  }

  const client = new OpenAI({ apiKey });
  const llmStartedAt = performance.now();
  await logAiTiming(context, "ai_llm_started", "AI LLM response started.", "started", {
    channel,
    language,
    tool: routed.toolResult.tool,
    scope: routed.toolResult.scope
  });
  let response: { output_text?: string | null };
  try {
    response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      instructions: [
        "You are the internal operations assistant for Quiksol Excel Intelligence System.",
        `Respond in ${languageName(language)}.`,
        `The current user channel is ${channel}.`,
        "Answer naturally, like a concise and capable teammate. Lead with the conclusion.",
        channel === "voice"
          ? "For voice, use short conversational sentences. Avoid markdown, tables, long lists, symbols, URLs and internal IDs."
          : "For text, use clean formatting. Use bullets only when they genuinely improve readability.",
        "Use only the controlled tool result provided. Never claim to run SQL and never suggest SQL.",
        "Do not reveal UUIDs, raw implementation field names, secrets, tokens, cookies or API keys.",
        "Respect the scope already applied by the server. Do not infer data outside the result.",
        "If the result is truncated, say that you are showing the first results and suggest a narrower question."
      ].join(" "),
      input: [
        `User role: ${context.profile.role}`,
        `Question: ${message}`,
        `Controlled database tool: ${routed.toolResult.tool}`,
        `Structured result ok: ${routed.toolResult.ok}`,
        `Authorized scope: ${routed.toolResult.scope}`,
        `Total rows in payload: ${routed.toolResult.total ?? "unknown"}`,
        `Server summary: ${routed.toolResult.summary}`,
        `Truncated: ${Boolean(routed.toolResult.truncated)}`,
        `Authorized result: ${compact(routed.toolResult.data)}`
      ].join("\n\n"),
      max_output_tokens: channel === "voice" ? 360 : 700
    });
  } catch (error) {
    await logAiTiming(context, "ai_llm_failed", "AI LLM response failed.", "failed", {
      channel,
      language,
      tool: routed.toolResult.tool,
      scope: routed.toolResult.scope
    }, Math.round(performance.now() - llmStartedAt), error);
    await logAiTiming(context, "ai_safe_response_returned", "AI safe response returned after LLM failure.", "completed", {
      channel,
      language,
      tool: routed.toolResult.tool
    });
    return buildAssistantResult({
      intent: routed.toolResult.tool,
      tool: routed.toolResult.tool,
      rawAnswer: routed.toolResult.summary || safeFallbackMessage(language),
      channel,
      dataLookupMs,
      llmMs: Math.round(performance.now() - llmStartedAt),
      startedAt,
      toolResult: routed.toolResult,
      language
    });
  }
  const llmMs = Math.round(performance.now() - llmStartedAt);
  await logAiTiming(context, "ai_llm_done", "AI LLM response completed.", "completed", {
    channel,
    language,
    tool: routed.toolResult.tool,
    scope: routed.toolResult.scope
  }, llmMs);

  return buildAssistantResult({
    intent: routed.toolResult.tool,
    tool: routed.toolResult.tool,
    rawAnswer: response.output_text?.trim() || routed.toolResult.summary,
    channel,
    dataLookupMs,
    llmMs,
    startedAt,
    toolResult: routed.toolResult,
    language
  });
}
