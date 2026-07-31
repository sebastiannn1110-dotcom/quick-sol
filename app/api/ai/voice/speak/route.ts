import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logSafeAiEvent } from "@/lib/ai/safe-logging";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { normalizeSpeechResponse } from "@/lib/ai/response-normalizer";
import { synthesizeSpeech } from "@/lib/voice/elevenlabs";
import { normalizeLanguage } from "@/lib/voice/transcription";
import {
  getVoiceMaxTtsChars,
  languageFromRequest,
  noStore,
  requireContentType,
  sanitizeTextForTts,
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

export async function POST(request: Request) {
  let responseLanguage = languageFromRequest(request);
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return noStore(context);

  if (process.env.ENABLE_VOICE_ASSISTANT === "false") {
    return json({ error: voiceMessage(responseLanguage, "voice_disabled"), code: "voice_disabled" }, 503);
  }
  if (process.env.ENABLE_VOICE_TTS === "false") {
    return json({ error: voiceMessage(responseLanguage, "tts_not_configured"), code: "tts_not_configured" }, 503);
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
      metadata: {
        language: responseLanguage,
        channel: "voice",
        errorCode: "RATE_LIMITED"
      }
    });
    return voiceRateLimitResponse(responseLanguage, rate.resetAt);
  }

  try {
    validateContentLength(request, getVoiceMaxTtsChars() * 4 + 4096);
    requireContentType(request, ["application/json"]);
    const body = (await request.json().catch(() => {
      throw new VoiceRequestError("invalid_body", 400);
    })) as { text?: unknown; language?: unknown } | null;
    if (!body || (body.text !== undefined && typeof body.text !== "string")) {
      throw new VoiceRequestError("invalid_body", 400);
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const language = normalizeLanguage(body?.language);
    responseLanguage = language;
    if (!text) return json({ error: voiceMessage(language, "text_required"), code: "text_required" }, 400);

    const speechText = sanitizeTextForTts(normalizeSpeechResponse(text));
    if (!speechText) throw new VoiceRequestError("text_required", 400);
    await logSafeAiEvent(context, {
      action: "ai_tts_started",
      status: "started",
      metadata: {
        language,
        channel: "voice",
        provider: "elevenlabs",
        characterCount: speechText.length
      }
    });

    const speech = await synthesizeSpeech({ text: speechText, language, signal: request.signal });

    await logSafeAiEvent(context, {
      action: "ai_tts_done",
      status: "completed",
      metadata: { language, channel: "voice", provider: "elevenlabs" }
    });

    return noStore(new Response(speech.bytes, {
      status: 200,
      headers: {
        "Content-Type": speech.mimeType
      }
    }));
  } catch (error) {
    await logSafeAiEvent(context, {
      action: "ai_tts_failed",
      status: "failed",
      error,
      metadata: {
        language: responseLanguage,
        channel: "voice",
        provider: "elevenlabs",
        timeout: error instanceof VoiceRequestError && error.status === 504
      }
    });

    if (error instanceof VoiceRequestError) {
      return json({ error: voiceMessage(responseLanguage, error.code), code: error.code }, error.status);
    }
    return json({ error: voiceMessage(responseLanguage, "tts_failed"), code: "tts_failed" }, 502);
  }
}
