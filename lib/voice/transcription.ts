import OpenAI, { toFile } from "openai";
import { detectAssistantLanguage, normalizeAssistantLanguage, type AssistantLanguage } from "@/lib/ai/language-detection";
import {
  createTimedSignal,
  getVoiceMaxAudioBytes,
  getVoiceMaxTranscriptChars,
  getVoiceTranscriptionTimeoutMs,
  validateTranscript,
  VoiceRequestError
} from "@/lib/voice/safety";

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "video/webm"
]);

const EXTENSION_BY_TYPE: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg"
};

export class VoiceInputError extends VoiceRequestError {
  constructor(
    code:
      | "audio_empty"
      | "audio_too_large"
      | "unsupported_audio"
      | "transcript_empty"
      | "transcript_too_long"
      | "transcription_unreadable",
    status = 400
  ) {
    super(code, status);
    this.name = "VoiceInputError";
  }
}

export class VoiceConfigError extends VoiceRequestError {
  constructor() {
    super("transcription_not_configured", 503);
    this.name = "VoiceConfigError";
  }
}

export class VoiceTranscriptionTimeoutError extends VoiceRequestError {
  constructor() {
    super("transcription_timeout", 504);
    this.name = "VoiceTranscriptionTimeoutError";
  }
}

export { getVoiceMaxAudioBytes, getVoiceMaxTranscriptChars };

export function normalizeLanguage(language: unknown): AssistantLanguage {
  return normalizeAssistantLanguage(language);
}

export function detectLanguageFromTranscript(text: string): AssistantLanguage {
  return detectAssistantLanguage(text);
}

export function normalizeAudioMimeType(type: string) {
  return type.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function validateAudioFile(file: File) {
  if (!file.size) throw new VoiceInputError("audio_empty");
  if (file.size > getVoiceMaxAudioBytes()) {
    throw new VoiceInputError("audio_too_large", 413);
  }
  const normalizedType = normalizeAudioMimeType(file.type);
  if (normalizedType && !ALLOWED_AUDIO_TYPES.has(normalizedType)) {
    throw new VoiceInputError("unsupported_audio", 422);
  }
}

function getOpenAIKey() {
  return process.env.OPEN_IA || process.env.OPENAI_API_KEY || "";
}

function getErrorStatus(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}

function isUnreadableAudioError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return getErrorStatus(error) === 400 && /audio file|unsupported|corrupt|could not be decoded/.test(message);
}

async function fileWithTranscriptionName(file: File) {
  const normalizedType = normalizeAudioMimeType(file.type) || "audio/webm";
  const extension = EXTENSION_BY_TYPE[normalizedType] ?? "webm";
  return toFile(await file.arrayBuffer(), `voice-message.${extension}`, { type: normalizedType });
}

export async function transcribeAudio(file: File, options: { signal?: AbortSignal } = {}) {
  if (options.signal?.aborted) throw new VoiceRequestError("request_cancelled", 499);
  validateAudioFile(file);
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new VoiceConfigError();
  }

  const client = new OpenAI({ apiKey });
  const timedSignal = createTimedSignal(getVoiceTranscriptionTimeoutMs(), options.signal);
  let result: unknown;
  try {
    result = await client.audio.transcriptions.create({
      file: await fileWithTranscriptionName(file),
      model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      response_format: "json"
    }, {
      signal: timedSignal.signal
    });
  } catch (error) {
    if (timedSignal.didTimeout()) throw new VoiceTranscriptionTimeoutError();
    if (options.signal?.aborted) throw new VoiceRequestError("request_cancelled", 499);
    if (isUnreadableAudioError(error)) {
      throw new VoiceInputError("transcription_unreadable", 422);
    }
    throw error;
  } finally {
    timedSignal.dispose();
  }

  const payload = result as { text?: string; language?: string; duration?: number };
  let transcript: string;
  try {
    transcript = validateTranscript(payload.text ?? "");
  } catch (error) {
    if (error instanceof VoiceRequestError) {
      throw new VoiceInputError(
        error.code === "transcript_too_long" ? "transcript_too_long" : "transcript_empty",
        error.status
      );
    }
    throw error;
  }

  return {
    transcript,
    detectedLanguage: payload.language ? normalizeLanguage(payload.language) : detectLanguageFromTranscript(transcript),
    confidence: null as number | null,
    duration: payload.duration ?? null
  };
}
