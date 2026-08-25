import type { AssistantLanguage } from "@/lib/ai/language-detection";

export type VoiceErrorCode =
  | "audio_required"
  | "text_required"
  | "audio_empty"
  | "audio_too_large"
  | "transcript_empty"
  | "transcript_too_long"
  | "unsupported_audio"
  | "invalid_content_length"
  | "unsupported_content_type"
  | "invalid_body"
  | "transcription_not_configured"
  | "transcription_unreadable"
  | "transcription_failed"
  | "transcription_timeout"
  | "tts_not_configured"
  | "tts_failed"
  | "tts_timeout"
  | "request_cancelled"
  | "rate_limited"
  | "voice_disabled"
  | "voice_failed"
  | "voice_text_fallback";

const MESSAGES: Record<AssistantLanguage, Record<VoiceErrorCode, string>> = {
  es: {
    audio_required: "Se requiere un archivo de audio.",
    text_required: "Se requiere texto.",
    audio_empty: "El archivo de audio está vacío.",
    audio_too_large: "El audio supera el límite permitido.",
    transcript_empty: "La transcripción está vacía.",
    transcript_too_long: "La transcripción supera el límite permitido.",
    unsupported_audio: "Formato de audio no compatible. Usa webm, mp3, wav, m4a u ogg.",
    invalid_content_length: "El tamaño declarado de la solicitud no es válido.",
    unsupported_content_type: "El tipo de contenido de la solicitud no es compatible.",
    invalid_body: "La solicitud de voz no es válida.",
    transcription_not_configured: "La transcripción de voz no está configurada.",
    transcription_unreadable: "No se pudo leer la grabación. Graba otra vez o usa webm, mp3, wav, m4a u ogg.",
    transcription_failed: "No se pudo transcribir el audio. Inténtalo de nuevo.",
    transcription_timeout: "La transcripción tardó demasiado. Inténtalo de nuevo.",
    tts_not_configured: "La respuesta de voz no está configurada.",
    tts_failed: "No se pudo generar la respuesta de voz.",
    tts_timeout: "La generación de voz tardó demasiado.",
    request_cancelled: "La solicitud de voz fue cancelada.",
    rate_limited: "Alcanzaste el límite de solicitudes de voz. Inténtalo de nuevo más tarde.",
    voice_disabled: "El asistente de voz está deshabilitado.",
    voice_failed: "No se pudo completar la solicitud de voz. Inténtalo de nuevo.",
    voice_text_fallback: "Te respondí por texto porque no fue posible generar la voz."
  },
  en: {
    audio_required: "An audio file is required.",
    text_required: "Text is required.",
    audio_empty: "The audio file is empty.",
    audio_too_large: "The audio exceeds the allowed size limit.",
    transcript_empty: "The transcript is empty.",
    transcript_too_long: "The transcript exceeds the allowed length.",
    unsupported_audio: "Unsupported audio format. Use webm, mp3, wav, m4a, or ogg.",
    invalid_content_length: "The declared request size is invalid.",
    unsupported_content_type: "The request content type is not supported.",
    invalid_body: "The voice request is invalid.",
    transcription_not_configured: "Voice transcription is not configured.",
    transcription_unreadable: "The recording could not be read. Record again or use webm, mp3, wav, m4a, or ogg.",
    transcription_failed: "The audio could not be transcribed. Please try again.",
    transcription_timeout: "Transcription took too long. Please try again.",
    tts_not_configured: "Voice responses are not configured.",
    tts_failed: "The voice response could not be generated.",
    tts_timeout: "Voice generation took too long.",
    request_cancelled: "The voice request was cancelled.",
    rate_limited: "You reached the voice request limit. Please try again later.",
    voice_disabled: "The voice assistant is disabled.",
    voice_failed: "The voice request could not be completed. Please try again.",
    voice_text_fallback: "I answered in text because voice generation was unavailable."
  },
  zh: {
    audio_required: "需要提供音频文件。",
    text_required: "需要提供文本。",
    audio_empty: "音频文件为空。",
    audio_too_large: "音频超过允许的大小限制。",
    transcript_empty: "转写内容为空。",
    transcript_too_long: "转写内容超过允许的长度。",
    unsupported_audio: "不支持此音频格式。请使用 webm、mp3、wav、m4a 或 ogg。",
    invalid_content_length: "请求声明的大小无效。",
    unsupported_content_type: "不支持此请求内容类型。",
    invalid_body: "语音请求无效。",
    transcription_not_configured: "语音转写尚未配置。",
    transcription_unreadable: "无法读取录音。请重新录制，或使用 webm、mp3、wav、m4a 或 ogg。",
    transcription_failed: "无法转写音频，请重试。",
    transcription_timeout: "语音转写超时，请重试。",
    tts_not_configured: "语音回复尚未配置。",
    tts_failed: "无法生成语音回复。",
    tts_timeout: "语音生成超时。",
    request_cancelled: "语音请求已取消。",
    rate_limited: "语音请求次数已达到限制，请稍后重试。",
    voice_disabled: "语音助手已停用。",
    voice_failed: "无法完成语音请求，请重试。",
    voice_text_fallback: "语音生成不可用，因此已改用文字回复。"
  }
};

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export class VoiceRequestError extends Error {
  constructor(
    public readonly code: VoiceErrorCode,
    public readonly status: number
  ) {
    super(code);
    this.name = "VoiceRequestError";
  }
}

export function voiceMessage(language: AssistantLanguage, code: VoiceErrorCode) {
  return MESSAGES[language][code];
}

export function getVoiceMaxAudioBytes() {
  const mb = Number(process.env.VOICE_MAX_AUDIO_MB ?? 15);
  return (Number.isFinite(mb) && mb > 0 ? mb : 15) * 1024 * 1024;
}

export function getVoiceMaxRequestBytes() {
  const configuredMb = Number(process.env.VOICE_MAX_REQUEST_MB);
  if (Number.isFinite(configuredMb) && configuredMb > 0) return configuredMb * 1024 * 1024;
  return getVoiceMaxAudioBytes() + 512 * 1024;
}

export function getVoiceMaxTranscriptChars() {
  return positiveInteger(process.env.VOICE_MAX_TRANSCRIPT_CHARS, 2000);
}

export function getVoiceMaxTtsChars() {
  return positiveInteger(process.env.VOICE_MAX_TTS_CHARS, 3000);
}

export function getVoiceTranscriptionTimeoutMs() {
  return positiveInteger(process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS, 30_000);
}

export function getVoiceTtsTimeoutMs() {
  return positiveInteger(process.env.VOICE_TTS_TIMEOUT_MS, 20_000);
}

export function languageFromRequest(request: Request): AssistantLanguage {
  const acceptLanguage = request.headers.get("accept-language")?.toLowerCase() ?? "";
  if (acceptLanguage.startsWith("zh")) return "zh";
  if (acceptLanguage.startsWith("en")) return "en";
  return "es";
}

export function validateContentLength(request: Request, maximumBytes = getVoiceMaxRequestBytes()) {
  const header = request.headers.get("content-length");
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw new VoiceRequestError("invalid_content_length", 400);
  const contentLength = Number(header);
  if (!Number.isSafeInteger(contentLength)) throw new VoiceRequestError("invalid_content_length", 400);
  if (contentLength > maximumBytes) throw new VoiceRequestError("audio_too_large", 413);
}

export function requireContentType(request: Request, allowed: readonly string[]) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!allowed.some((value) => contentType.includes(value))) {
    throw new VoiceRequestError("unsupported_content_type", 415);
  }
  return contentType;
}

export function validateTranscript(text: string) {
  const normalized = text.trim();
  if (!normalized) throw new VoiceRequestError("transcript_empty", 400);
  if (normalized.length > getVoiceMaxTranscriptChars()) {
    throw new VoiceRequestError("transcript_too_long", 413);
  }
  return normalized;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const INTERNAL_ID_LABEL_PATTERN = /\b(?:trace|request|user)[\s_-]*id\s*[:#=-]?\s*[A-Z0-9_-]+\b/gi;

export function sanitizeTextForTts(text: string) {
  return text
    .replace(UUID_PATTERN, "")
    .replace(EMAIL_PATTERN, "")
    .replace(INTERNAL_ID_LABEL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, getVoiceMaxTtsChars());
}

export function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export function voiceRateLimitResponse(
  language: AssistantLanguage,
  resetAt: number
) {
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return noStore(new Response(
    JSON.stringify({
      error: voiceMessage(language, "rate_limited"),
      code: "rate_limited"
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(retryAfterSeconds)
      }
    }
  ));
}

export function createTimedSignal(timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Provider timeout", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
