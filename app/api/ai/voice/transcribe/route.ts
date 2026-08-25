import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logSafeAiEvent } from "@/lib/ai/safe-logging";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { transcribeAudio } from "@/lib/voice/transcription";
import {
  languageFromRequest,
  noStore,
  requireContentType,
  validateContentLength,
  voiceMessage,
  voiceRateLimitResponse,
  VoiceRequestError
} from "@/lib/voice/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(payload: unknown, status = 200) {
  return noStore(NextResponse.json(payload, { status }));
}

function audioFromFormData(formData: FormData) {
  const audio = formData.get("audio");
  return audio instanceof File ? audio : null;
}

export async function POST(request: Request) {
  const language = languageFromRequest(request);
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return noStore(context);

  if (process.env.ENABLE_VOICE_ASSISTANT === "false") {
    return json({ error: voiceMessage(language, "voice_disabled"), code: "voice_disabled" }, 503);
  }

  const rate = checkRateLimit({
    key: `voice:${context.profile.id}`,
    limit: 20,
    windowMs: 10 * 60 * 1000
  });
  if (!rate.allowed) {
    await logSafeAiEvent(context, {
      action: "voice_rate_limit_exceeded",
      status: "failed",
      metadata: { language, channel: "voice", errorCode: "RATE_LIMITED" }
    });
    return voiceRateLimitResponse(language, rate.resetAt);
  }

  try {
    validateContentLength(request);
    requireContentType(request, ["multipart/form-data"]);
    const formData = await request.formData().catch(() => {
      throw new VoiceRequestError("invalid_body", 400);
    });
    const audio = audioFromFormData(formData);
    if (!audio) return json({ error: voiceMessage(language, "audio_required"), code: "audio_required" }, 400);

    await logSafeAiEvent(context, {
      action: "ai_voice_transcription_started",
      status: "started",
      metadata: { language, channel: "voice", provider: "openai" }
    });

    const result = await transcribeAudio(audio, { signal: request.signal });

    await logSafeAiEvent(context, {
      action: "ai_voice_transcription_done",
      status: "completed",
      metadata: { language: result.detectedLanguage, channel: "voice", provider: "openai" }
    });

    return json(result);
  } catch (error) {
    await logSafeAiEvent(context, {
      action: "ai_voice_failed",
      status: "failed",
      error,
      metadata: {
        language,
        channel: "voice",
        provider: "openai",
        timeout: error instanceof VoiceRequestError && error.status === 504
      }
    });

    if (error instanceof VoiceRequestError) {
      return json({ error: voiceMessage(language, error.code), code: error.code }, error.status);
    }
    return json({ error: voiceMessage(language, "transcription_failed"), code: "transcription_failed" }, 502);
  }
}
