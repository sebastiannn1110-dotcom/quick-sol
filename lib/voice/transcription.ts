import OpenAI, { toFile } from "openai";
import { detectAssistantLanguage, normalizeAssistantLanguage, type AssistantLanguage } from "@/lib/ai/language-detection";

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

export class VoiceInputError extends Error {
  status = 400;
}

export class VoiceConfigError extends Error {
  status = 503;
}

export function getVoiceMaxAudioBytes() {
  const mb = Number(process.env.VOICE_MAX_AUDIO_MB ?? 15);
  return (Number.isFinite(mb) && mb > 0 ? mb : 15) * 1024 * 1024;
}

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
  if (!file.size) throw new VoiceInputError("Audio file is empty.");
  if (file.size > getVoiceMaxAudioBytes()) {
    throw new VoiceInputError(`Audio file exceeds the ${Math.round(getVoiceMaxAudioBytes() / 1024 / 1024)} MB limit.`);
  }
  const normalizedType = normalizeAudioMimeType(file.type);
  if (normalizedType && !ALLOWED_AUDIO_TYPES.has(normalizedType)) {
    throw new VoiceInputError("Unsupported audio format. Use webm, mp3, wav, m4a or ogg.");
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
  const hasExtension = Boolean(file.name && /\.[a-z0-9]+$/i.test(file.name));
  const extension = EXTENSION_BY_TYPE[normalizedType] ?? "webm";
  const name = hasExtension ? file.name : `voice-message.${extension}`;
  return toFile(await file.arrayBuffer(), name, { type: normalizedType });
}

export async function transcribeAudio(file: File) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new VoiceConfigError("Voice assistant transcription is not configured. Please add OPEN_IA.");
  }

  validateAudioFile(file);

  const client = new OpenAI({ apiKey });
  const result = await client.audio.transcriptions.create({
    file: await fileWithTranscriptionName(file),
    model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    response_format: "json"
  }).catch((error: unknown) => {
    if (isUnreadableAudioError(error)) {
      throw new VoiceInputError("OpenAI could not read this recording. Please record again or upload an mp3, wav, m4a, ogg, or webm file.");
    }
    throw error;
  });

  const payload = result as { text?: string; language?: string; duration?: number };
  const transcript = payload.text?.trim() ?? "";
  if (!transcript) throw new VoiceInputError("OpenAI transcription returned an empty transcript.");

  return {
    transcript,
    detectedLanguage: payload.language ? normalizeLanguage(payload.language) : detectLanguageFromTranscript(transcript),
    confidence: null as number | null,
    duration: payload.duration ?? null
  };
}
