import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";
import { getAuthContext } from "@/lib/auth/context";
import { answerAssistantQuestion, AssistantConfigError } from "@/lib/ai/assistantCore";
import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { detectAssistantLanguage } from "@/lib/ai/language-detection";
import { logSafeAiEvent } from "@/lib/ai/safe-logging";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { synthesizeSpeech } from "@/lib/voice/elevenlabs";
import {
  normalizeLanguage,
  transcribeAudio
} from "@/lib/voice/transcription";
import {
  languageFromRequest,
  noStore,
  requireContentType,
  sanitizeTextForTts,
  validateContentLength,
  validateTranscript,
  voiceMessage,
  voiceRateLimitResponse,
  VoiceRequestError
} from "@/lib/voice/safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VoiceTimings {
  transcriptionMs: number;
  dataLookupMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

function json(payload: unknown, status = 200) {
  return noStore(NextResponse.json(payload, { status }));
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getAudio(formData: FormData) {
  const audio = formData.get("audio");
  return audio instanceof File ? audio : null;
}

async function logVoice(
  context: AuthContext,
  action: string,
  message: string,
  status: "started" | "completed" | "failed",
  metadata?: Record<string, unknown>,
  durationMs?: number,
  error?: unknown
) {
  void message;
  const detectedLanguage =
    metadata?.detectedLanguage === "en" || metadata?.detectedLanguage === "zh"
      ? metadata.detectedLanguage
      : "es";
  await logSafeAiEvent(context, {
    action,
    status,
    durationMs,
    error,
    metadata: {
      language: detectedLanguage,
      channel: "voice",
      provider: action.includes("tts") ? "elevenlabs" : action.includes("transcription") ? "openai" : "deterministic",
      durationMs,
      state: status,
      timeout: error instanceof VoiceRequestError && error.status === 504
    }
  });
}

export async function POST(request: Request) {
  let responseLanguage = languageFromRequest(request);
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return noStore(context);

  if (process.env.ENABLE_VOICE_ASSISTANT === "false") {
    return json({ error: voiceMessage(responseLanguage, "voice_disabled"), code: "voice_disabled" }, 503);
  }

  const rate = await checkPersistentRateLimit({
    action: "voice_assistant",
    identifier: context.profile.id,
    limit: 20,
    windowSeconds: 10 * 60,
    blockSeconds: 5 * 60
  });
  if (!rate.allowed) {
    await logVoice(context, "voice_rate_limit_exceeded", "Voice rate limit exceeded.", "failed");
    return voiceRateLimitResponse(responseLanguage, rate.resetAt);
  }

  const totalStartedAt = performance.now();
  const timings: VoiceTimings = {
    transcriptionMs: 0,
    dataLookupMs: 0,
    llmMs: 0,
    ttsMs: 0,
    totalMs: 0
  };

  try {
    validateContentLength(request);
    const contentType = requireContentType(request, ["multipart/form-data", "application/json"]);
    let transcript = "";
    let detectedLanguage: AssistantLanguage = "es";
    let duration: number | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData().catch(() => {
        throw new VoiceRequestError("invalid_body", 400);
      });
      const audio = getAudio(formData);
      const textMessage = getString(formData, "message") || getString(formData, "transcript");
      const requestedLanguage = getString(formData, "language");
      if (requestedLanguage) responseLanguage = normalizeLanguage(requestedLanguage);

      if (audio) {
        await logVoice(context, "voice_upload_received", "Voice upload received.", "completed", {
          fileSize: audio.size,
          fileType: audio.type
        });

        await logVoice(context, "ai_voice_transcription_started", "AI voice transcription started.", "started", {
          fileSize: audio.size,
          fileType: audio.type
        });
        const transcriptionStartedAt = performance.now();
        const transcription = await transcribeAudio(audio, { signal: request.signal });
        timings.transcriptionMs = Math.round(performance.now() - transcriptionStartedAt);
        transcript = transcription.transcript;
        detectedLanguage = transcription.detectedLanguage;
        responseLanguage = detectedLanguage;
        duration = transcription.duration;

        await logVoice(context, "ai_voice_transcription_done", "AI voice transcription completed.", "completed", {
          detectedLanguage,
          duration,
          transcriptionMs: timings.transcriptionMs
        }, timings.transcriptionMs);
      } else {
        transcript = validateTranscript(textMessage);
        detectedLanguage = requestedLanguage ? normalizeLanguage(requestedLanguage) : detectAssistantLanguage(transcript);
        responseLanguage = detectedLanguage;
      }
    } else {
      const body = (await request.json().catch(() => {
        throw new VoiceRequestError("invalid_body", 400);
      })) as { message?: unknown; transcript?: unknown; language?: unknown } | null;
      if (
        !body ||
        (body.message !== undefined && typeof body.message !== "string") ||
        (body.transcript !== undefined && typeof body.transcript !== "string")
      ) {
        throw new VoiceRequestError("invalid_body", 400);
      }
      const message = typeof body.message === "string" ? body.message : "";
      const suppliedTranscript = typeof body.transcript === "string" ? body.transcript : "";
      transcript = validateTranscript(message.trim() || suppliedTranscript.trim());
      detectedLanguage = body?.language ? normalizeLanguage(body.language) : detectAssistantLanguage(transcript);
      responseLanguage = detectedLanguage;
    }

    const answer = await answerAssistantQuestion({
      context,
      message: transcript,
      language: detectedLanguage,
      channel: "voice"
    });
    timings.dataLookupMs = answer.timings.dataLookupMs;
    timings.llmMs = answer.timings.llmMs;

    let audioBase64: string | null = null;
    let audioMimeType: string | null = null;
    let voiceUsed: string | null = null;
    let audioError: string | null = null;

    try {
      if (process.env.ENABLE_VOICE_TTS === "false") {
        throw new VoiceRequestError("tts_not_configured", 503);
      }
      const safeSpeechText = sanitizeTextForTts(answer.speechText);
      if (!safeSpeechText) throw new VoiceRequestError("text_required", 400);
      await logVoice(context, "ai_tts_started", "AI text-to-speech started.", "started", {
        detectedLanguage,
        textLength: safeSpeechText.length
      });
      const ttsStartedAt = performance.now();
      const speech = await synthesizeSpeech({
        text: safeSpeechText,
        language: detectedLanguage,
        signal: request.signal
      });
      timings.ttsMs = Math.round(performance.now() - ttsStartedAt);
      audioBase64 = speech.audioBase64;
      audioMimeType = speech.mimeType;
      voiceUsed = speech.voiceUsed;

      await logVoice(context, "ai_tts_done", "AI text-to-speech completed.", "completed", {
        detectedLanguage,
        voiceUsed,
        ttsMs: timings.ttsMs
      }, timings.ttsMs);
    } catch (error) {
      timings.ttsMs = Math.round(performance.now() - totalStartedAt) - timings.transcriptionMs - timings.dataLookupMs - timings.llmMs;
      audioError = voiceMessage(detectedLanguage, "voice_text_fallback");
      await logVoice(context, "ai_tts_failed", "AI text-to-speech failed; returning text only.", "failed", {
        detectedLanguage,
        ttsMs: Math.max(0, timings.ttsMs)
      }, Math.max(0, timings.ttsMs), error);
    }

    timings.totalMs = Math.round(performance.now() - totalStartedAt);
    await logVoice(context, "ai_voice_total_done", "AI voice request completed.", "completed", {
      detectedLanguage,
      hasAudio: Boolean(audioBase64),
      tool: answer.tool,
      timings
    }, timings.totalMs);

    return json({
      transcript,
      answerText: answer.answerText,
      speechText: answer.speechText,
      intent: answer.intent,
      tool: answer.tool,
      toolResult: answer.toolResult,
      detectedLanguage,
      duration,
      voiceUsed,
      audioBase64,
      audioMimeType,
      audioError,
      timings
    });
  } catch (error) {
    timings.totalMs = Math.round(performance.now() - totalStartedAt);
    await logVoice(context, "ai_voice_failed", "AI voice request failed.", "failed", { timings }, timings.totalMs, error);

    if (error instanceof VoiceRequestError) {
      return json({ error: voiceMessage(responseLanguage, error.code), code: error.code, timings }, error.status);
    }
    if (error instanceof AssistantConfigError) {
      return json({ error: voiceMessage(responseLanguage, "voice_failed"), code: "voice_failed", timings }, error.status);
    }
    return json({ error: voiceMessage(responseLanguage, "voice_failed"), code: "voice_failed", timings }, 502);
  }
}
