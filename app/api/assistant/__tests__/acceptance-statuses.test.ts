import { beforeEach, describe, expect, it, vi } from "vitest";
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
      full_name: "Synthetic Employee",
      email: "synthetic.employee@example.test",
      role: "employee",
      department: "Synthetic QA",
      region: "Synthetic Region",
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

function request() {
  return new Request("https://synthetic.test/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Show the selected authorized Opportunity Finder result.",
      language: "en"
    })
  });
}

describe("assistant HTTP acceptance status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue(context());
    checkPersistentRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: Date.now() + 60_000,
      persistent: false
    });
  });

  it("returns 404 for an authorized job that does not exist", async () => {
    const { AssistantToolRequestError } = await import("@/lib/ai/database-tools");
    const { POST } = await import("@/app/api/assistant/route");
    answerAssistantQuestion.mockRejectedValueOnce(
      new AssistantToolRequestError(
        "The selected authorized comparison does not exist.",
        404,
        "JOB_NOT_FOUND"
      )
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(payload).toMatchObject({ code: "JOB_NOT_FOUND" });
    expect(JSON.stringify(payload)).not.toContain("internal-trace");
  }, 15_000);

  it("returns a sanitized 502 instead of HTTP 200 for an unexpected provider failure", async () => {
    const { POST } = await import("@/app/api/assistant/route");
    answerAssistantQuestion.mockRejectedValueOnce(
      new Error("private synthetic upstream diagnostic")
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({ code: "OPERATION_FAILED" });
    expect(JSON.stringify(payload)).not.toContain("private synthetic upstream diagnostic");
    expect(JSON.stringify(payload)).not.toContain("internal-trace");
  });

  it("returns 503 when a required provider is not configured", async () => {
    const { AssistantConfigError } = await import("@/lib/ai/assistantCore");
    const { POST } = await import("@/app/api/assistant/route");
    answerAssistantQuestion.mockRejectedValueOnce(new AssistantConfigError());

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(JSON.stringify(payload)).not.toContain("internal-trace");
  });

  it("returns 403 for a server-enforced permission denial", async () => {
    const { AssistantRequestError } = await import("@/lib/ai/assistantCore");
    const { POST } = await import("@/app/api/assistant/route");
    answerAssistantQuestion.mockRejectedValueOnce(
      new AssistantRequestError(
        "You do not have permission to view that information.",
        403,
        "PERMISSION_DENIED"
      )
    );

    const response = await POST(request());
    await expect(response.json()).resolves.toMatchObject({
      code: "PERMISSION_DENIED"
    });
    expect(response.status).toBe(403);
  });
});
