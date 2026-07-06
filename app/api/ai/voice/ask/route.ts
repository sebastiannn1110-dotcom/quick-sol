import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";
import { getAuthContext } from "@/lib/auth/context";
import { answerAssistantQuestion, AssistantConfigError } from "@/lib/ai/assistantCore";
import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { detectAssistantLanguage } from "@/lib/ai/language-detection";
import { logger } from "@/lib/logger/logger";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { synthesizeSpeech } from "@/lib/voice/elevenlabs";
import {
  normalizeLanguage,
  transcribeAudio,
  VoiceConfigError,
  VoiceInputError
} from "@/lib/voice/transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VoiceTimings {
  transcriptionMs: number;
  dataLookupMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
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
  await logger[status === "failed" ? "warn" : "info"]({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "voice",
    action,
    message,
    status,
    durationMs,
    metadata,
    error
  });
}

function friendlyVoiceError(language: AssistantLanguage) {
  if (language === "zh") return "语音生成失败了，但我已经用文字回答你。";
  if (language === "en") return "I answered in text because voice generation failed.";
  return "Te respondi por texto porque fallo la voz.";
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  if (process.env.ENABLE_VOICE_ASSISTANT === "false") {
    return NextResponse.json({ error: "Voice assistant is disabled." }, { status: 503 });
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
    return rateLimitResponse(rate.resetAt);
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
    const contentType = request.headers.get("content-type") ?? "";
    let transcript = "";
    let detectedLanguage: AssistantLanguage = "es";
    let duration: number | null = null;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const audio = getAudio(formData);
      const textMessage = getString(formData, "message") || getString(formData, "transcript");
      const requestedLanguage = getString(formData, "language");

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
        const transcription = await transcribeAudio(audio);
        timings.transcriptionMs = Math.round(performance.now() - transcriptionStartedAt);
        transcript = transcription.transcript;
        detectedLanguage = transcription.detectedLanguage;
        duration = transcription.duration;

        await logVoice(context, "ai_voice_transcription_done", "AI voice transcription completed.", "completed", {
          detectedLanguage,
          duration,
          transcriptionMs: timings.transcriptionMs
        }, timings.transcriptionMs);
      } else {
        transcript = textMessage;
        detectedLanguage = requestedLanguage ? normalizeLanguage(requestedLanguage) : detectAssistantLanguage(transcript);
      }
    } else {
      const body = (await request.json().catch(() => null)) as { message?: string; transcript?: string; language?: string } | null;
      transcript = body?.message?.trim() || body?.transcript?.trim() || "";
      detectedLanguage = body?.language ? normalizeLanguage(body.language) : detectAssistantLanguage(transcript);
    }

    if (!transcript) return NextResponse.json({ error: "Audio or text message is required." }, { status: 400 });

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
      await logVoice(context, "ai_tts_started", "AI text-to-speech started.", "started", {
        detectedLanguage,
        textLength: answer.speechText.length
      });
      const ttsStartedAt = performance.now();
      const speech = await synthesizeSpeech({
        text: answer.speechText,
        language: detectedLanguage,
        traceId: context.requestMeta.traceId
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
      audioError = friendlyVoiceError(detectedLanguage);
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

    return NextResponse.json({
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
      timings,
      traceId: context.requestMeta.traceId
    });
  } catch (error) {
    timings.totalMs = Math.round(performance.now() - totalStartedAt);
    await logVoice(context, "ai_voice_failed", "AI voice request failed.", "failed", { timings }, timings.totalMs, error);

    if (error instanceof VoiceInputError || error instanceof VoiceConfigError || error instanceof AssistantConfigError) {
      return NextResponse.json({ error: error.message, timings }, { status: error.status });
    }
    return NextResponse.json({ error: "Voice assistant failed. Please try again.", timings }, { status: 502 });
  }
}
