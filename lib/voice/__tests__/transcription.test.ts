import { describe, expect, it } from "vitest";
import {
  detectLanguageFromTranscript,
  getVoiceMaxTranscriptChars,
  normalizeAudioMimeType,
  normalizeLanguage,
  validateAudioFile,
  VoiceInputError
} from "@/lib/voice/transcription";
import {
  sanitizeTextForTts,
  validateContentLength,
  validateTranscript,
  voiceMessage,
  VoiceRequestError
} from "@/lib/voice/safety";

describe("voice transcription helpers", () => {
  it("normalizes supported languages", () => {
    expect(normalizeLanguage("es")).toBe("es");
    expect(normalizeLanguage("english")).toBe("en");
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("unknown")).toBe("es");
  });

  it("detects language from transcript text", () => {
    expect(detectLanguageFromTranscript("Muestrame el ultimo Excel")).toBe("es");
    expect(detectLanguageFromTranscript("Find supplier MCC")).toBe("en");
    expect(detectLanguageFromTranscript("帮我找供应商 MCC")).toBe("zh");
  });

  it("accepts browser audio MIME parameters", () => {
    expect(normalizeAudioMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    const file = new File(["x"], "voice-message.webm", { type: "audio/webm;codecs=opus" });
    expect(() => validateAudioFile(file)).not.toThrow();
  });

  it("rejects invalid audio formats", () => {
    const file = new File(["x"], "bad.txt", { type: "text/plain" });
    expect(() => validateAudioFile(file)).toThrow(VoiceInputError);
    try {
      validateAudioFile(file);
    } catch (error) {
      expect(error).toMatchObject({ code: "unsupported_audio", status: 422 });
    }
  });

  it("rejects empty and oversized audio with coherent status codes", () => {
    const empty = new File([], "empty.webm", { type: "audio/webm" });
    expect(() => validateAudioFile(empty)).toThrowError(
      expect.objectContaining({ code: "audio_empty", status: 400 })
    );

    process.env.VOICE_MAX_AUDIO_MB = "0.000001";
    const oversized = new File(["oversized"], "large.webm", { type: "audio/webm" });
    expect(() => validateAudioFile(oversized)).toThrowError(
      expect.objectContaining({ code: "audio_too_large", status: 413 })
    );
    delete process.env.VOICE_MAX_AUDIO_MB;
  });

  it("rejects an oversized Content-Length before parsing a body", () => {
    const request = new Request("https://app.test/api/ai/voice/transcribe", {
      method: "POST",
      headers: { "content-length": "101" }
    });
    expect(() => validateContentLength(request, 100)).toThrowError(
      expect.objectContaining({ code: "audio_too_large", status: 413 })
    );
  });

  it("limits transcript length without truncating it silently", () => {
    process.env.VOICE_MAX_TRANSCRIPT_CHARS = "8";
    expect(getVoiceMaxTranscriptChars()).toBe(8);
    expect(() => validateTranscript("123456789")).toThrowError(
      expect.objectContaining({ code: "transcript_too_long", status: 413 })
    );
    delete process.env.VOICE_MAX_TRANSCRIPT_CHARS;
  });

  it("removes UUIDs, emails and internal ids before TTS", () => {
    const safe = sanitizeTextForTts(
      "Contact qa.user@example.test, traceId: internal-123 and 10000000-0000-4000-8000-000000000001."
    );
    expect(safe).not.toContain("qa.user@example.test");
    expect(safe).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(safe).not.toContain("internal-123");
    expect(safe).toContain("Contact");
  });

  it("provides public error messages in ES, EN and ZH", () => {
    expect(voiceMessage("es", "audio_required")).toBe("Se requiere un archivo de audio.");
    expect(voiceMessage("en", "audio_required")).toBe("An audio file is required.");
    expect(voiceMessage("zh", "audio_required")).toBe("需要提供音频文件。");
    expect(voiceMessage("es", "rate_limited")).toContain("límite");
    expect(voiceMessage("en", "rate_limited")).toContain("limit");
    expect(voiceMessage("zh", "rate_limited")).toContain("限制");
    expect(new VoiceRequestError("request_cancelled", 499)).toMatchObject({
      code: "request_cancelled",
      status: 499
    });
  });
});
