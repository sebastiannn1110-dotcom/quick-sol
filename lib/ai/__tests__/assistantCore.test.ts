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
  const responsesCreate = vi.fn();
  const logger = {
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OPEN_IA;
    delete process.env.OPENAI_API_KEY;
    responsesCreate.mockResolvedValue({ output_text: "Respuesta segura." });
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
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        responses = {
          create: responsesCreate
        }
      }
    }));
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

  it("returns a safe answer when data lookup times out", async () => {
    routeAssistantDatabaseQuery.mockRejectedValueOnce({
      code: "57014",
      message: "canceling statement due to statement timeout"
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("admin"),
      message: "que columnas tiene el ultimo archivo subido",
      language: "es",
      channel: "text"
    });

    expect(result.answer).toContain("La consulta tard");
    expect(result.answer).not.toContain("57014");
    expect(result.answer).not.toContain("statement timeout");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_timeout" }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_safe_response_returned" }));
  });

  it("does not send sensitive commercial fields to OpenAI", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    routeAssistantDatabaseQuery.mockResolvedValueOnce({
      permissionDenied: false,
      toolResult: {
        ok: true,
        tool: "searchBusinessRecords",
        scope: "company",
        total: 1,
        rows: [],
        data: [
          {
            mpn: "ABC123",
            qty: 10,
            supplier_name: "Sensitive Supplier",
            customer: "Sensitive Customer",
            po: "PO-777",
            cost: 12.34,
            price: 20.45,
            gp_rate: 0.42,
            raw_data: {
              MPN: "ABC123",
              "UNIT COST": 12.34,
              PriceBook: 20.45,
              "USD Extended Price": 204.5,
              GP: 8.11,
              "GP rate": "42%",
              PO: "PO-777"
            }
          }
        ],
        summary: "Se encontro 1 registro visible.",
        empty: false,
        truncated: false,
        deterministic: false
      }
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    await answerAssistantQuestion({
      context: authContext("admin"),
      message: "Busca MPN ABC123",
      language: "es",
      channel: "text"
    });

    const input = String(responsesCreate.mock.calls[0]?.[0]?.input ?? "");
    expect(input).toContain("ABC123");
    expect(input).not.toContain("Sensitive Supplier");
    expect(input).not.toContain("Sensitive Customer");
    expect(input).not.toContain("PO-777");
    expect(input).not.toContain("12.34");
    expect(input).not.toContain("20.45");
    expect(input).not.toContain("204.5");
    expect(input).not.toContain("42%");
  });
});
