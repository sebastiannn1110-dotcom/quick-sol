import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { transcribeAudio, VoiceConfigError, VoiceInputError } from "@/lib/voice/transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function audioFromFormData(formData: FormData) {
  const audio = formData.get("audio");
  return audio instanceof File ? audio : null;
}

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
  if (!rate.allowed) {
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "voice_rate_limit_exceeded",
      message: "Voice rate limit exceeded.",
      status: "failed"
    });
    return rateLimitResponse(rate.resetAt);
  }

  try {
    const formData = await request.formData();
    const audio = audioFromFormData(formData);
    if (!audio) return NextResponse.json({ error: "Audio file is required." }, { status: 400 });

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "ai_voice_transcription_started",
      message: "Voice transcription started.",
      status: "started",
      metadata: { fileSize: audio.size, fileType: audio.type }
    });

    const result = await transcribeAudio(audio);

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "ai_voice_transcription_done",
      message: "Voice transcription completed.",
      status: "completed",
      metadata: { detectedLanguage: result.detectedLanguage, duration: result.duration }
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
      module: "voice",
      action: "ai_voice_failed",
      message: "Voice transcription failed.",
      status: "failed",
      error
    });

    if (error instanceof VoiceInputError || error instanceof VoiceConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "OpenAI transcription failed. Please try again." }, { status: 502 });
  }
}
