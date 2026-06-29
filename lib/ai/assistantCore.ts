import OpenAI from "openai";
import type { AuthContext } from "@/lib/auth/context";
import { routeAssistantDatabaseQuery } from "@/lib/ai/ai-query-router";

export type AssistantLanguage = "es" | "en" | "zh";

export class AssistantConfigError extends Error {
  status = 503;
}

function getOpenAIKey() {
  return process.env.OPEN_IA || process.env.OPENAI_API_KEY || "";
}

function languageName(language: AssistantLanguage) {
  if (language === "zh") return "Simplified Chinese";
  if (language === "en") return "English";
  return "Spanish";
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

function compact(value: unknown, max = 14_000) {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length > max ? `${serialized.slice(0, max)}\n[resultado truncado]` : serialized;
}

export async function answerAssistantQuestion({
  context,
  message,
  language
}: {
  context: AuthContext;
  message: string;
  language: AssistantLanguage;
}) {
  const routed = await routeAssistantDatabaseQuery(context, message);
  if (routed.permissionDenied) return { intent: "permission_denied", tool: null, answer: permissionMessage(language) };
  if (!routed.toolResult || routed.toolResult.empty) {
    return { intent: routed.toolResult?.tool ?? "no_result", tool: routed.toolResult?.tool ?? null, answer: noDataMessage(language) };
  }

  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return { intent: routed.toolResult.tool, tool: routed.toolResult.tool, answer: routed.toolResult.summary };
  }

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    instructions: [
      "You are the internal operations assistant for Quiksol Excel Intelligence System.",
      `Respond in ${languageName(language)}.`,
      "Answer naturally, like a concise and capable teammate. Lead with the conclusion.",
      "Use only the controlled tool result provided. Never claim to run SQL and never suggest SQL.",
      "Do not reveal UUIDs, raw implementation field names, secrets, tokens, cookies or API keys.",
      "Respect the scope already applied by the server. Do not infer data outside the result.",
      "Use at most one short heading and a small bullet list only when it improves readability.",
      "If the result is truncated, say that you are showing the first results and suggest a narrower question."
    ].join(" "),
    input: [
      `User role: ${context.profile.role}`,
      `Question: ${message}`,
      `Controlled database tool: ${routed.toolResult.tool}`,
      `Server summary: ${routed.toolResult.summary}`,
      `Truncated: ${Boolean(routed.toolResult.truncated)}`,
      `Authorized result: ${compact(routed.toolResult.data)}`
    ].join("\n\n"),
    max_output_tokens: 700
  });

  return {
    intent: routed.toolResult.tool,
    tool: routed.toolResult.tool,
    answer: response.output_text?.trim() || routed.toolResult.summary
  };
}
