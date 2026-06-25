import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { ElevenLabsConfigError, ElevenLabsSynthesisError, synthesizeSpeech } from "@/lib/voice/elevenlabs";
import { normalizeLanguage } from "@/lib/voice/transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  if (process.env.ENABLE_VOICE_ASSISTANT === "false") {
    return NextResponse.json({ error: "Voice assistant is disabled." }, { status: 503 });
  }

  const rate = checkRateLimit({
    key: `voice:${context.profile.id}`,
    limit: 20,
    windowMs: 10 * 60 * 1000
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  try {
    const body = (await request.json().catch(() => null)) as { text?: string; language?: string } | null;
    const text = body?.text?.trim();
    const language = normalizeLanguage(body?.language);
    if (!text) return NextResponse.json({ error: "Text is required." }, { status: 400 });

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "elevenlabs_tts_started",
      message: "ElevenLabs TTS started.",
      status: "started",
      metadata: { detectedLanguage: language }
    });

    const speech = await synthesizeSpeech({ text, language, traceId: context.requestMeta.traceId });

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "elevenlabs_tts_completed",
      message: "ElevenLabs TTS completed.",
      status: "completed",
      metadata: { detectedLanguage: language, voiceUsed: speech.voiceUsed }
    });

    return new Response(speech.bytes, {
      status: 200,
      headers: {
        "Content-Type": speech.mimeType,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "elevenlabs_tts_failed",
      message: "ElevenLabs TTS failed.",
      status: "failed",
      error
    });

    if (error instanceof ElevenLabsConfigError || error instanceof ElevenLabsSynthesisError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Voice response failed. Please try again." }, { status: 502 });
  }
}
