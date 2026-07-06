import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

function authContext(role: "admin" | "manager" | "employee" = "employee"): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Demo User",
      email: "demo@quiksol.local",
      role,
      department: "Sales",
      region: "US",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/assistant",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("assistant core", () => {
  const routeAssistantDatabaseQuery = vi.fn();
  const logger = {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OPEN_IA;
    delete process.env.OPENAI_API_KEY;
    routeAssistantDatabaseQuery.mockResolvedValue({
      permissionDenied: false,
      toolResult: {
        ok: true,
        tool: "getRecordsByMpn",
        scope: "own",
        total: 1,
        rows: [{ mpn: "ABC123", supplier: "Supplier A" }],
        data: [{ mpn: "ABC123", supplier: "Supplier A" }],
        summary: "**Supplier A** tiene el mejor precio para ABC123.",
        empty: false,
        truncated: false
      }
    });
    vi.doMock("@/lib/ai/ai-query-router", () => ({ routeAssistantDatabaseQuery }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
  });

  it("answers text channel without calling TTS and includes structured tool metadata", async () => {
    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("employee"),
      message: "Busca MPN ABC123",
      language: "es",
      channel: "text"
    });

    expect(result.channel).toBe("text");
    expect(result.answer).toContain("Supplier A");
    expect(result.toolResult).toEqual(expect.objectContaining({ tool: "getRecordsByMpn", scope: "own", total: 1 }));
    expect(result.timings.dataLookupMs).toEqual(expect.any(Number));
  });

  it("prepares voice-safe speech text without markdown", async () => {
    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("employee"),
      message: "Busca MPN ABC123",
      language: "es",
      channel: "voice"
    });

    expect(result.channel).toBe("voice");
    expect(result.speechText).not.toContain("**");
    expect(result.speechText).toContain("Supplier A");
  });
});
