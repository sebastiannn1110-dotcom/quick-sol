import type { AssistantLanguage } from "@/lib/ai/language-detection";
import { normalizeLanguage } from "@/lib/voice/transcription";
import {
  createTimedSignal,
  getVoiceTtsTimeoutMs,
  sanitizeTextForTts,
  VoiceRequestError
} from "@/lib/voice/safety";

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

export class ElevenLabsConfigError extends VoiceRequestError {
  constructor() {
    super("tts_not_configured", 503);
    this.name = "ElevenLabsConfigError";
  }
}

export class ElevenLabsSynthesisError extends VoiceRequestError {
  constructor() {
    super("tts_failed", 502);
    this.name = "ElevenLabsSynthesisError";
  }
}

export class ElevenLabsTimeoutError extends VoiceRequestError {
  constructor() {
    super("tts_timeout", 504);
    this.name = "ElevenLabsTimeoutError";
  }
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
    throw new ElevenLabsConfigError();
  }
  if (!getVoiceIdForLanguage(language)) {
    throw new ElevenLabsConfigError();
  }
}

export async function synthesizeSpeech({
  text,
  language,
  signal
}: {
  text: string;
  language: AssistantLanguage;
  signal?: AbortSignal;
}) {
  if (signal?.aborted) throw new VoiceRequestError("request_cancelled", 499);
  validateElevenLabsConfig(language);

  const voiceId = getVoiceIdForLanguage(language);
  const safeText = sanitizeTextForTts(text);
  if (!safeText) throw new VoiceRequestError("text_required", 400);
  const timedSignal = createTimedSignal(getVoiceTtsTimeoutMs(), signal);
  let response: Response;
  try {
    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: safeText,
        model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75
        }
      }),
      signal: timedSignal.signal
    });
  } catch {
    if (timedSignal.didTimeout()) throw new ElevenLabsTimeoutError();
    if (signal?.aborted) throw new VoiceRequestError("request_cancelled", 499);
    throw new ElevenLabsSynthesisError();
  } finally {
    timedSignal.dispose();
  }

  if (!response.ok) {
    throw new ElevenLabsSynthesisError();
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    audioBase64: bytes.toString("base64"),
    mimeType: response.headers.get("content-type") || "audio/mpeg",
    voiceUsed: getVoiceNameForLanguage(language),
    voiceId
  };
}
