import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transcriptionCreate, toFileMock } = vi.hoisted(() => ({
  transcriptionCreate: vi.fn(),
  toFileMock: vi.fn(async (value: unknown, name: string, options: unknown) => ({
    value,
    name,
    options
  }))
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    audio = {
      transcriptions: {
        create: transcriptionCreate
      }
    };
  },
  toFile: toFileMock
}));

import {
  transcribeAudio,
  VoiceInputError,
  VoiceTranscriptionTimeoutError
} from "@/lib/voice/transcription";

const originalKey = process.env.OPEN_IA;
const originalTimeout = process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS;
const originalMaxTranscript = process.env.VOICE_MAX_TRANSCRIPT_CHARS;

describe("transcription provider boundary", () => {
  beforeEach(() => {
    process.env.OPEN_IA = "synthetic-test-key";
    transcriptionCreate.mockReset();
    toFileMock.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPEN_IA;
    else process.env.OPEN_IA = originalKey;
    if (originalTimeout === undefined) delete process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS;
    else process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS = originalTimeout;
    if (originalMaxTranscript === undefined) delete process.env.VOICE_MAX_TRANSCRIPT_CHARS;
    else process.env.VOICE_MAX_TRANSCRIPT_CHARS = originalMaxTranscript;
  });

  it("passes a cancellable signal and returns a synthetic transcript", async () => {
    transcriptionCreate.mockResolvedValue({
      text: "Which parts have stock available?",
      language: "en",
      duration: 1.25
    });

    const result = await transcribeAudio(
      new File(["synthetic-audio"], "sample.webm", { type: "audio/webm" })
    );

    expect(result).toMatchObject({
      transcript: "Which parts have stock available?",
      detectedLanguage: "en",
      duration: 1.25
    });
    expect(transcriptionCreate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(toFileMock).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "voice-message.webm",
      { type: "audio/webm" }
    );
  });

  it("rejects an empty provider transcript", async () => {
    transcriptionCreate.mockResolvedValue({ text: "   " });
    await expect(transcribeAudio(
      new File(["synthetic-audio"], "sample.webm", { type: "audio/webm" })
    )).rejects.toMatchObject({
      code: "transcript_empty",
      status: 400
    } satisfies Partial<VoiceInputError>);
  });

  it("rejects a provider transcript over the configured maximum", async () => {
    process.env.VOICE_MAX_TRANSCRIPT_CHARS = "5";
    transcriptionCreate.mockResolvedValue({ text: "123456" });
    await expect(transcribeAudio(
      new File(["synthetic-audio"], "sample.webm", { type: "audio/webm" })
    )).rejects.toMatchObject({
      code: "transcript_too_long",
      status: 413
    } satisfies Partial<VoiceInputError>);
  });

  it("returns a 504-class error when OpenAI transcription times out", async () => {
    process.env.VOICE_TRANSCRIPTION_TIMEOUT_MS = "1";
    transcriptionCreate.mockImplementation((_body: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });

    await expect(transcribeAudio(
      new File(["synthetic-audio"], "sample.webm", { type: "audio/webm" })
    )).rejects.toBeInstanceOf(VoiceTranscriptionTimeoutError);
  });

  it("honors cancellation before calling OpenAI", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(transcribeAudio(
      new File(["synthetic-audio"], "sample.webm", { type: "audio/webm" }),
      { signal: controller.signal }
    )).rejects.toMatchObject({
      code: "request_cancelled",
      status: 499
    });
    expect(transcriptionCreate).not.toHaveBeenCalled();
  });
});
