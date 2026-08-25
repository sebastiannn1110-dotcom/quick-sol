import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

function authenticatedContext(): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "20000000-0000-4000-8000-000000000001",
      full_name: "Synthetic Voice User",
      email: "synthetic.voice@example.test",
      role: "employee",
      department: "QA",
      region: "TEST",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/ai/voice",
      traceId: "internal-trace-id",
      requestId: "internal-request-id"
    }
  };
}

async function configureVoiceRoutes() {
  const answerAssistantQuestion = vi.fn(async () => ({
    answerText: "Synthetic answer",
    speechText: "Contact qa.user@example.test 10000000-0000-4000-8000-000000000001 for details.",
    intent: "general",
    tool: "syntheticTool",
    toolResult: {
      ok: true,
      tool: "syntheticTool",
      scope: "own",
      total: 1,
      summary: "Synthetic summary"
    },
    timings: {
      dataLookupMs: 2,
      llmMs: 3,
      totalMs: 5
    }
  }));
  const transcribeAudio = vi.fn(async () => ({
    transcript: "Which parts have stock?",
    detectedLanguage: "en",
    confidence: null,
    duration: 1
  }));
  const synthesizeSpeech = vi.fn(async () => ({
    bytes: Buffer.from([1, 2, 3]),
    audioBase64: "AQID",
    mimeType: "audio/mpeg",
    voiceUsed: "Synthetic Voice",
    voiceId: "synthetic-voice"
  }));

  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => authenticatedContext())
  }));
  vi.doMock("@/lib/ai/assistantCore", () => ({
    AssistantConfigError: class AssistantConfigError extends Error {
      status = 503;
    },
    answerAssistantQuestion
  }));
  vi.doMock("@/lib/voice/transcription", async () => {
    const actual = await vi.importActual<typeof import("@/lib/voice/transcription")>("@/lib/voice/transcription");
    return {
      ...actual,
      transcribeAudio
    };
  });
  vi.doMock("@/lib/voice/elevenlabs", async () => {
    const actual = await vi.importActual<typeof import("@/lib/voice/elevenlabs")>("@/lib/voice/elevenlabs");
    return {
      ...actual,
      synthesizeSpeech
    };
  });
  vi.doMock("@/lib/security/rateLimit", () => ({
    checkRateLimit: vi.fn(() => ({ allowed: true, resetAt: Date.now() + 60_000 })),
    rateLimitResponse: vi.fn(() => new Response(null, { status: 429 }))
  }));
  vi.doMock("@/lib/security/persistent-rate-limit", () => ({
    checkPersistentRateLimit: vi.fn(async () => ({
      allowed: true,
      resetAt: Date.now() + 60_000,
      remaining: 19
    }))
  }));
  vi.doMock("@/lib/logger/logger", () => ({
    logger: {
      info: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined)
    }
  }));

  const [ask, transcribe, speak] = await Promise.all([
    import("../ask/route"),
    import("../transcribe/route"),
    import("../speak/route")
  ]);
  return {
    ask,
    transcribe,
    speak,
    answerAssistantQuestion,
    transcribeAudio,
    synthesizeSpeech
  };
}

describe("voice route hardening", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ENABLE_VOICE_ASSISTANT;
    delete process.env.ENABLE_VOICE_TTS;
    delete process.env.VOICE_MAX_REQUEST_MB;
  });

  it("rejects an oversized voice body before multipart parsing", async () => {
    process.env.VOICE_MAX_REQUEST_MB = "1";
    const routes = await configureVoiceRoutes();
    const request = new Request("https://app.test/api/ai/voice/ask", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=synthetic",
        "content-length": String(2 * 1024 * 1024)
      }
    });
    const formDataSpy = vi.spyOn(request, "formData");

    const response = await routes.ask.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.code).toBe("audio_too_large");
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(routes.transcribeAudio).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  }, 15_000);

  it("returns a no-store success without exposing traceId and sanitizes TTS", async () => {
    const routes = await configureVoiceRoutes();
    const response = await routes.ask.POST(new Request("https://app.test/api/ai/voice/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Which parts have stock?", language: "en" })
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload).not.toHaveProperty("traceId");
    expect(payload.audioBase64).toBe("AQID");
    expect(routes.synthesizeSpeech).toHaveBeenCalledOnce();
    const providerText = routes.synthesizeSpeech.mock.calls[0]?.[0]?.text;
    expect(providerText).not.toContain("qa.user@example.test");
    expect(providerText).not.toContain("10000000-0000-4000-8000-000000000001");
    expect(routes.synthesizeSpeech.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves a localized text fallback when TTS fails", async () => {
    const routes = await configureVoiceRoutes();
    routes.synthesizeSpeech.mockRejectedValueOnce(new Error("synthetic provider failure"));

    const response = await routes.ask.POST(new Request("https://app.test/api/ai/voice/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "显示有库存的零件。", language: "zh" })
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.answerText).toBe("Synthetic answer");
    expect(payload.audioBase64).toBeNull();
    expect(payload.audioError).toBe("语音生成不可用，因此已改用文字回复。");
  });

  it("preserves text when TTS is explicitly disabled", async () => {
    process.env.ENABLE_VOICE_TTS = "false";
    const routes = await configureVoiceRoutes();
    const response = await routes.ask.POST(new Request("https://app.test/api/ai/voice/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "¿Qué MPN tienen stock?", language: "es" })
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.answerText).toBe("Synthetic answer");
    expect(payload.audioBase64).toBeNull();
    expect(payload.audioError).toBe("Te respondí por texto porque no fue posible generar la voz.");
    expect(routes.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("applies early Content-Length validation to standalone transcription", async () => {
    process.env.VOICE_MAX_REQUEST_MB = "1";
    const routes = await configureVoiceRoutes();
    const response = await routes.transcribe.POST(new Request("https://app.test/api/ai/voice/transcribe", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=synthetic",
        "content-length": String(2 * 1024 * 1024)
      }
    }));
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.code).toBe("audio_too_large");
    expect(routes.transcribeAudio).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("maps a transcription timeout to localized HTTP 504", async () => {
    const routes = await configureVoiceRoutes();
    const { VoiceRequestError } = await import("@/lib/voice/safety");
    routes.transcribeAudio.mockRejectedValueOnce(new VoiceRequestError("transcription_timeout", 504));
    const formData = new FormData();
    formData.append("audio", new File(["synthetic"], "sample.webm", { type: "audio/webm" }));

    const response = await routes.transcribe.POST(new Request("https://app.test/api/ai/voice/transcribe", {
      method: "POST",
      headers: { "accept-language": "en" },
      body: formData
    }));
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload).toEqual({
      error: "Transcription took too long. Please try again.",
      code: "transcription_timeout"
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("sanitizes standalone TTS input and returns no-store audio", async () => {
    const routes = await configureVoiceRoutes();
    const response = await routes.speak.POST(new Request("https://app.test/api/ai/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Email qa.user@example.test, id 10000000-0000-4000-8000-000000000001.",
        language: "en"
      })
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const providerText = routes.synthesizeSpeech.mock.calls[0]?.[0]?.text;
    expect(providerText).not.toContain("qa.user@example.test");
    expect(providerText).not.toContain("10000000-0000-4000-8000-000000000001");
  });
});
