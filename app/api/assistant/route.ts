import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { answerAssistantQuestion, AssistantConfigError, type AssistantLanguage } from "@/lib/ai/assistantCore";
import { detectAssistantLanguage } from "@/lib/ai/language-detection";
import { SAFE_ASSISTANT_FALLBACK } from "@/lib/ai/response-normalizer";
import { logger } from "@/lib/logger/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeRequestLanguage(language: unknown): AssistantLanguage {
  if (language === "zh") return "zh";
  if (language === "en") return "en";
  return "es";
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const body = (await request.json().catch(() => null)) as { message?: string; language?: string } | null;
  const message = body?.message?.trim();
  const language = normalizeRequestLanguage(body?.language);
  if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

  const rate = await checkPersistentRateLimit({
    action: "assistant",
    identifier: context.profile.id,
    limit: 30,
    windowSeconds: 15 * 60,
    blockSeconds: 5 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const detectedLanguage = body?.language ? language : detectAssistantLanguage(message);
  try {
    const startedAt = performance.now();
    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "ai",
      action: "ai_text_started",
      message: "AI text assistant started.",
      status: "started",
      metadata: { detectedLanguage }
    });
    const result = await answerAssistantQuestion({ context, message, language: detectedLanguage, channel: "text" });
    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "ai",
      action: "ai_text_done",
      message: "AI text assistant completed.",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { detectedLanguage, tool: result.tool, timings: result.timings }
    });
    return NextResponse.json(result);
  } catch (error) {
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "ai",
      action: "ai_text_failed",
      message: "AI text assistant failed.",
      status: "failed",
      error
    });
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "ai",
      action: "ai_safe_response_returned",
      message: "AI safe response returned to user after route failure.",
      status: "completed",
      metadata: { detectedLanguage, configError: error instanceof AssistantConfigError }
    });
    if (error instanceof AssistantConfigError) {
      return NextResponse.json({ answer: SAFE_ASSISTANT_FALLBACK, answerText: SAFE_ASSISTANT_FALLBACK }, { status: 200 });
    }

    return NextResponse.json({ answer: SAFE_ASSISTANT_FALLBACK, answerText: SAFE_ASSISTANT_FALLBACK }, { status: 200 });
  }
}
