import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { answerAssistantQuestion, AssistantConfigError, type AssistantLanguage } from "@/lib/ai/assistantCore";
import { logger } from "@/lib/logger/logger";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { synthesizeSpeech } from "@/lib/voice/elevenlabs";
import {
  detectLanguageFromTranscript,
  normalizeLanguage,
  transcribeAudio,
  VoiceConfigError,
  VoiceInputError
} from "@/lib/voice/transcription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getAudio(formData: FormData) {
  const audio = formData.get("audio");
  return audio instanceof File ? audio : null;
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
        await logger.info({
          traceId: context.requestMeta.traceId,
          requestId: context.requestMeta.requestId,
          userId: context.profile.id,
          userEmail: context.profile.email,
          userRole: context.profile.role,
          route: context.requestMeta.route,
          module: "voice",
          action: "voice_upload_received",
          message: "Voice upload received.",
          status: "completed",
          metadata: { fileSize: audio.size, fileType: audio.type }
        });

        await logger.info({
          traceId: context.requestMeta.traceId,
          requestId: context.requestMeta.requestId,
          userId: context.profile.id,
          userEmail: context.profile.email,
          userRole: context.profile.role,
          route: context.requestMeta.route,
          module: "voice",
          action: "voice_transcription_started",
          message: "Voice transcription started.",
          status: "started",
          metadata: { fileSize: audio.size, fileType: audio.type }
        });

        try {
          const transcription = await transcribeAudio(audio);
          transcript = transcription.transcript;
          detectedLanguage = transcription.detectedLanguage;
          duration = transcription.duration;

          await logger.info({
            traceId: context.requestMeta.traceId,
            requestId: context.requestMeta.requestId,
            userId: context.profile.id,
            userEmail: context.profile.email,
            userRole: context.profile.role,
            route: context.requestMeta.route,
            module: "voice",
            action: "voice_transcription_completed",
            message: "Voice transcription completed.",
            status: "completed",
            metadata: { detectedLanguage, duration }
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
            action: "voice_transcription_failed",
            message: "Voice transcription failed.",
            status: "failed",
            error
          });
          throw error;
        }
      } else {
        transcript = textMessage;
        detectedLanguage = requestedLanguage ? normalizeLanguage(requestedLanguage) : detectLanguageFromTranscript(transcript);
      }
    } else {
      const body = (await request.json().catch(() => null)) as { message?: string; transcript?: string; language?: string } | null;
      transcript = body?.message?.trim() || body?.transcript?.trim() || "";
      detectedLanguage = body?.language ? normalizeLanguage(body.language) : detectLanguageFromTranscript(transcript);
    }

    if (!transcript) return NextResponse.json({ error: "Audio or text message is required." }, { status: 400 });

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "ai_voice_query_started",
      message: "AI voice query started.",
      status: "started",
      metadata: { detectedLanguage }
    });

    const answer = await answerAssistantQuestion({
      context,
      message: transcript,
      language: detectedLanguage
    });

    let audioBase64: string | null = null;
    let audioMimeType: string | null = null;
    let voiceUsed: string | null = null;
    let audioError: string | null = null;

    try {
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
        metadata: { detectedLanguage }
      });
      const speech = await synthesizeSpeech({
        text: answer.answer,
        language: detectedLanguage,
        traceId: context.requestMeta.traceId
      });
      audioBase64 = speech.audioBase64;
      audioMimeType = speech.mimeType;
      voiceUsed = speech.voiceUsed;

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
        metadata: { detectedLanguage, voiceUsed }
      });
    } catch (error) {
      audioError = error instanceof Error ? error.message : "Voice generation failed.";
      await logger.warn({
        traceId: context.requestMeta.traceId,
        requestId: context.requestMeta.requestId,
        userId: context.profile.id,
        userEmail: context.profile.email,
        userRole: context.profile.role,
        route: context.requestMeta.route,
        module: "voice",
        action: "elevenlabs_tts_failed",
        message: "ElevenLabs TTS failed; returning text only.",
        status: "failed",
        metadata: { detectedLanguage },
        error
      });
    }

    await logger.info({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      module: "voice",
      action: "ai_voice_query_completed",
      message: "AI voice query completed.",
      status: "completed",
      metadata: { detectedLanguage, hasAudio: Boolean(audioBase64) }
    });

    return NextResponse.json({
      transcript,
      answerText: answer.answer,
      intent: answer.intent,
      detectedLanguage,
      duration,
      voiceUsed,
      audioBase64,
      audioMimeType,
      audioError,
      traceId: context.requestMeta.traceId
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
      action: "ai_voice_query_failed",
      message: "AI voice query failed.",
      status: "failed",
      error
    });

    if (error instanceof VoiceInputError || error instanceof VoiceConfigError || error instanceof AssistantConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Voice assistant failed. Please try again." }, { status: 502 });
  }
}
