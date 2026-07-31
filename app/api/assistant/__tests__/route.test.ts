import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";

const {
  getAuthContext,
  checkPersistentRateLimit,
  answerAssistantQuestion
} = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  checkPersistentRateLimit: vi.fn(),
  answerAssistantQuestion: vi.fn()
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext }));
vi.mock("@/lib/security/persistent-rate-limit", () => ({ checkPersistentRateLimit }));
vi.mock("@/lib/ai/assistantCore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/assistantCore")>();
  return { ...actual, answerAssistantQuestion };
});
vi.mock("@/lib/logger/logger", () => ({
  logger: {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined)
  }
}));

function context(): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "10000000-0000-4000-8000-000000000001",
      full_name: "Synthetic User",
      email: "synthetic@example.test",
      role: "employee",
      department: "QA",
      region: "Test",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/assistant",
      traceId: "internal-trace",
      requestId: "internal-request"
    }
  };
}

function request(body: unknown, contentType = "application/json") {
  return new Request("https://synthetic.test/api/assistant", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

describe("assistant HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue(context());
    checkPersistentRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: Date.now() + 60_000,
      persistent: false
    });
    answerAssistantQuestion.mockResolvedValue({
      intent: "stock",
      tool: "getStockNeedsSummary",
      answer: "Synthetic answer",
      answerText: "Synthetic answer",
      speechText: "Synthetic answer",
      language: "en",
      channel: "text",
      sourceType: "stock_needs",
      generatedWithAi: false,
      fallbackUsed: false,
      toolResult: null,
      timings: { dataLookupMs: 1, llmMs: 0, totalMs: 1 }
    });
  });

  it("returns 401 without a session and 403 for an inactive profile", async () => {
    const { POST } = await import("@/app/api/assistant/route");
    getAuthContext.mockResolvedValueOnce(
      NextResponse.json({ error: "Authentication required" }, { status: 401 })
    );
    expect((await POST(request({ message: "hello" }))).status).toBe(401);

    getAuthContext.mockResolvedValueOnce(
      NextResponse.json({ error: "Your user is inactive." }, { status: 403 })
    );
    expect((await POST(request({ message: "hello" }))).status).toBe(403);
  }, 15_000);

  it("returns 400, 413 and 422 for invalid request classes", async () => {
    const { POST } = await import("@/app/api/assistant/route");
    expect((await POST(request({ message: "hello" }, "text/plain"))).status).toBe(400);
    expect((await POST(request({ message: "x".repeat(2_001) }))).status).toBe(413);
    expect((await POST(request({ message: "hello", jobId: "bad-id" }))).status).toBe(422);
  });

  it("returns localized 429 with no-store", async () => {
    const { POST } = await import("@/app/api/assistant/route");
    checkPersistentRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 10_000,
      persistent: false
    });
    const response = await POST(request({ message: "Which parts have stock?", language: "es" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      error: expect.stringContaining("query limit")
    });
  });

  it("uses the detected question language over the UI fallback", async () => {
    const { POST } = await import("@/app/api/assistant/route");
    await POST(request({ message: "Which parts have stock available?", language: "es" }));
    expect(answerAssistantQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" })
    );
  });

  it("returns 504 and never exposes the traceId for a tool timeout", async () => {
    const { AssistantRequestError } = await import("@/lib/ai/assistantCore");
    const { POST } = await import("@/app/api/assistant/route");
    answerAssistantQuestion.mockRejectedValueOnce(
      new AssistantRequestError("The operation took too long.", 504, "TOOL_TIMEOUT")
    );
    const response = await POST(request({ message: "Which parts have stock?" }));
    expect(response.status).toBe(504);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(JSON.stringify(payload)).not.toContain("internal-trace");
  });
});
