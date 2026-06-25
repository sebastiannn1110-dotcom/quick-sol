import type { AssistantLanguage } from "@/lib/ai/assistantCore";
import { normalizeLanguage } from "@/lib/voice/transcription";

const DEFAULT_VOICES: Record<AssistantLanguage, string> = {
  es: "tomkxGQGz4b1kE0EM722",
  en: "c6SfcYrb2t09NHXiT80T",
  zh: "bhJUNIXWQQ94l8eI2VUf"
};

const VOICE_NAMES: Record<AssistantLanguage, string> = {
  es: "Mario",
  en: "Jhonathan",
  zh: "Emi"
};

export class ElevenLabsConfigError extends Error {
  status = 503;
}

export class ElevenLabsSynthesisError extends Error {
  status = 502;
}

export function getVoiceIdForLanguage(language: unknown) {
  const normalized = normalizeLanguage(language);
  if (normalized === "en") return process.env.ELEVENLABS_VOICE_EN || DEFAULT_VOICES.en;
  if (normalized === "zh") return process.env.ELEVENLABS_VOICE_ZH || DEFAULT_VOICES.zh;
  return process.env.ELEVENLABS_VOICE_ES || DEFAULT_VOICES.es;
}

export function getVoiceNameForLanguage(language: unknown) {
  return VOICE_NAMES[normalizeLanguage(language)];
}

export function validateElevenLabsConfig(language: unknown) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new ElevenLabsConfigError("Voice response is not configured. Please add ELEVENLABS_API_KEY.");
  }
  if (!getVoiceIdForLanguage(language)) {
    throw new ElevenLabsConfigError("Voice for this language is not configured.");
  }
}

export async function synthesizeSpeech({
  text,
  language,
  traceId
}: {
  text: string;
  language: AssistantLanguage;
  traceId?: string;
}) {
  validateElevenLabsConfig(language);

  const voiceId = getVoiceIdForLanguage(language);
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: text.slice(0, 4500),
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    throw new ElevenLabsSynthesisError(`ElevenLabs TTS failed with status ${response.status}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    audioBase64: bytes.toString("base64"),
    mimeType: response.headers.get("content-type") || "audio/mpeg",
    voiceUsed: getVoiceNameForLanguage(language),
    voiceId,
    traceId
  };
}
