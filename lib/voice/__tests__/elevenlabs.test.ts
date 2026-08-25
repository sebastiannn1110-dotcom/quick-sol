import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ElevenLabsConfigError,
  ElevenLabsTimeoutError,
  getVoiceIdForLanguage,
  synthesizeSpeech,
  validateElevenLabsConfig
} from "@/lib/voice/elevenlabs";

const originalApiKey = process.env.ELEVENLABS_API_KEY;
const originalTimeout = process.env.VOICE_TTS_TIMEOUT_MS;

describe("elevenlabs helpers", () => {
  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalApiKey;
    if (originalTimeout === undefined) delete process.env.VOICE_TTS_TIMEOUT_MS;
    else process.env.VOICE_TTS_TIMEOUT_MS = originalTimeout;
    vi.unstubAllGlobals();
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

  it("never sends UUIDs or emails to ElevenLabs", async () => {
    process.env.ELEVENLABS_API_KEY = "synthetic-test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech({
      text: "Send to qa.user@example.test with id 10000000-0000-4000-8000-000000000001.",
      language: "en"
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text).not.toContain("qa.user@example.test");
    expect(body.text).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts ElevenLabs with a bounded timeout", async () => {
    process.env.ELEVENLABS_API_KEY = "synthetic-test-key";
    process.env.VOICE_TTS_TIMEOUT_MS = "1";
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }));

    await expect(synthesizeSpeech({ text: "Synthetic response", language: "en" }))
      .rejects.toBeInstanceOf(ElevenLabsTimeoutError);
  });
});
