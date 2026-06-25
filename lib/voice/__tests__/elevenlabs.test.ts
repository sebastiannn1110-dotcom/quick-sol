import { afterEach, describe, expect, it } from "vitest";
import { ElevenLabsConfigError, getVoiceIdForLanguage, validateElevenLabsConfig } from "@/lib/voice/elevenlabs";

const originalApiKey = process.env.ELEVENLABS_API_KEY;

describe("elevenlabs helpers", () => {
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalApiKey;
  });

  it("chooses the correct default voice by language", () => {
    expect(getVoiceIdForLanguage("es")).toBe("tomkxGQGz4b1kE0EM722");
    expect(getVoiceIdForLanguage("en")).toBe("c6SfcYrb2t09NHXiT80T");
    expect(getVoiceIdForLanguage("zh")).toBe("bhJUNIXWQQ94l8eI2VUf");
  });

  it("fails gracefully when ElevenLabs API key is missing", () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect(() => validateElevenLabsConfig("es")).toThrow(ElevenLabsConfigError);
  });
});
