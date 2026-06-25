import { describe, expect, it } from "vitest";
import { detectLanguageFromTranscript, normalizeLanguage, validateAudioFile, VoiceInputError } from "@/lib/voice/transcription";

describe("voice transcription helpers", () => {
  it("normalizes supported languages", () => {
    expect(normalizeLanguage("es")).toBe("es");
    expect(normalizeLanguage("english")).toBe("en");
    expect(normalizeLanguage("zh-CN")).toBe("zh");
    expect(normalizeLanguage("unknown")).toBe("es");
  });

  it("detects language from transcript text", () => {
    expect(detectLanguageFromTranscript("Muéstrame el último Excel")).toBe("es");
    expect(detectLanguageFromTranscript("Find supplier MCC")).toBe("en");
    expect(detectLanguageFromTranscript("帮我找供应商 MCC")).toBe("zh");
  });

  it("rejects invalid audio formats", () => {
    const file = new File(["x"], "bad.txt", { type: "text/plain" });
    expect(() => validateAudioFile(file)).toThrow(VoiceInputError);
  });
});
