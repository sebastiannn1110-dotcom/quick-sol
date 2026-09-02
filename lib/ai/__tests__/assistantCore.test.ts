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
      intent: "mpn_search",
      confidence: 1,
      ambiguous: false,
      plan: {
        intent: "mpn_search",
        confidence: 1,
        tool: "getRecordsByMpn",
        answerMode: "item_detail",
        language: "es",
        entity: "business_record",
        metric: null,
        mpn: "ABC123",
        requiresClarification: false,
        policyDecision: "allow"
      },
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
    expect(result.answer).toContain("1 registros autorizados para el MPN ABC123");
    expect(result.answer).not.toContain("Supplier A");
    expect(result.answer).not.toContain("precio");
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
    expect(result.speechText).toContain("1 registros autorizados para el MPN ABC123");
    expect(result.speechText).not.toContain("Supplier A");
  });

  it("uses the same server router for latest-upload attribution in text and voice", async () => {
    routeAssistantDatabaseQuery.mockResolvedValue({
      permissionDenied: false,
      intent: "latest_upload_attribution",
      confidence: 1,
      ambiguous: false,
      plan: {
        intent: "latest_upload_attribution",
        confidence: 1,
        tool: "getLatestUploadAttribution",
        answerMode: "item_detail",
        language: "es",
        entity: "upload",
        metric: null,
        mpn: null,
        requiresClarification: false,
        policyDecision: "allow"
      },
      toolResult: {
        ok: true,
        tool: "getLatestUploadAttribution",
        scope: "own",
        total: 1,
        rows: [{ fileName: "DEMO_UPLOAD.xlsx" }],
        data: {
          item: {
            fileName: "DEMO_UPLOAD.xlsx",
            uploadedAt: "2026-08-29T12:00:00.000Z",
            status: "completed",
            uploaderDisplayName: "Maya Torres"
          }
        },
        summary: "Latest upload attribution.",
        empty: false,
        truncated: false,
        deterministic: true
      }
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const input = {
      context: authContext("employee"),
      message: "\u00bfQui\u00e9n subi\u00f3 el \u00faltimo archivo y qu\u00e9 archivo fue?",
      language: "es" as const
    };
    const textResult = await answerAssistantQuestion({ ...input, channel: "text" });
    const voiceResult = await answerAssistantQuestion({ ...input, channel: "voice" });

    expect(textResult.answer).toContain("Maya Torres");
    expect(textResult.answer).toContain("DEMO_UPLOAD.xlsx");
    expect(voiceResult.speechText).toContain("Maya Torres");
    expect(voiceResult.speechText).toContain("DEMO UPLOAD");
    expect(voiceResult.speechText).toContain("xlsx");
    expect(routeAssistantDatabaseQuery).toHaveBeenCalledTimes(2);
    for (const call of routeAssistantDatabaseQuery.mock.calls) {
      expect(call).toEqual([
        expect.any(Object),
        input.message,
        { language: "es", jobId: undefined, history: [] }
      ]);
    }
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("uses the same read-only commerce router for text and voice", async () => {
    routeAssistantDatabaseQuery.mockResolvedValue({
      permissionDenied: false,
      intent: "employee_quote_metrics",
      confidence: 1,
      ambiguous: false,
      plan: {
        intent: "employee_quote_metrics",
        confidence: 1,
        tool: "employee_quote_metrics",
        answerMode: "summary",
        language: "en",
        entity: "employee_quote_metrics",
        metric: "Accepted Quote Value",
        mpn: null,
        requiresClarification: false,
        policyDecision: "allow"
      },
      toolResult: {
        ok: true,
        tool: "employee_quote_metrics",
        scope: "team",
        total: 1,
        rows: [],
        data: {
          analyticsScope: "subtree",
          currency: "USD",
          queryMode: "ranking",
          sortBy: "accepted_quote_value",
          selectedEmployee: {
            name: "Maya Torres",
            quotesCreated: 4,
            quotesSent: 3,
            quotesAccepted: 2,
            quotesRejected: 1,
            acceptedQuoteValue: 500
          },
          ranking: [],
          totals: {}
        },
        summary: "Authorized employee quote metrics.",
        empty: false,
        truncated: false,
        deterministic: true
      }
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const input = {
      context: authContext("manager"),
      message: "Who has the highest Accepted Quote Value?",
      language: "en" as const
    };
    const textResult = await answerAssistantQuestion({ ...input, channel: "text" });
    const voiceResult = await answerAssistantQuestion({ ...input, channel: "voice" });

    expect(textResult.answer).toContain("Maya Torres");
    expect(textResult.answer).toContain("highest Accepted Quote Value");
    expect(voiceResult.speechText).toContain("Maya Torres");
    expect(routeAssistantDatabaseQuery).toHaveBeenCalledTimes(2);
    for (const call of routeAssistantDatabaseQuery.mock.calls) {
      expect(call).toEqual([
        expect.any(Object),
        input.message,
        { language: "en", jobId: undefined, history: [] }
      ]);
    }
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("raises a localized 504 when data lookup times out", async () => {
    routeAssistantDatabaseQuery.mockRejectedValueOnce({
      code: "57014",
      message: "canceling statement due to statement timeout"
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    await expect(answerAssistantQuestion({
      context: authContext("admin"),
      message: "que columnas tiene el ultimo archivo subido",
      language: "es",
      channel: "text"
    })).rejects.toMatchObject({ status: 504, code: "TOOL_TIMEOUT" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_timeout" }));
  });

  it.each([
    ["es", "quien es el mejor vendedor", "No pude consultar las métricas en este momento."],
    ["en", "how many clients do we have", "I could not query clients right now."],
    ["zh", "查找 Amazon-demo", "目前无法查询客户数据。"]
  ] as const)("fails closed with a localized business-tool error in %s", async (language, message, expected) => {
    routeAssistantDatabaseQuery.mockRejectedValueOnce(new Error("synthetic database failure"));

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    await expect(answerAssistantQuestion({
      context: authContext("admin"),
      message,
      language,
      channel: "text"
    })).rejects.toMatchObject({
      message: expected,
      status: 502,
      code: "TOOL_FAILED"
    });
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it.each([
    "Muestrame los costos de los MPN",
    "Que GP rate tenemos",
    "Muestrame precios y margenes"
  ])("blocks sensitive Spanish questions before DB and LLM: %s", async (message) => {
    process.env.OPENAI_API_KEY = "test-key";

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("admin"),
      message,
      language: "es",
      channel: "text"
    });

    expect(result.answer).toBe("No tengo permiso para mostrar costos, precios o margen en esta vista.");
    expect(result.intent).toBe("sensitiveDataPermissionDenied");
    expect(result.tool).toBe("sensitiveDataPermissionDenied");
    expect(result.timings.dataLookupMs).toBe(0);
    expect(result.timings.llmMs).toBe(0);
    expect(routeAssistantDatabaseQuery).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(result.answer).not.toMatch(/Supabase|Render|OpenAI|timeout|statement/i);
  });

  it.each([
    ["employee", "cuanto gana Demo Owner"],
    ["manager", "what is Demo Owner's salary"],
    ["admin", "Demo Owner 的工资是多少"]
  ] as const)("never expands salary access through the assistant for %s", async (role, message) => {
    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext(role),
      message,
      language: message.includes("工资") ? "zh" : message.startsWith("what") ? "en" : "es",
      channel: "text"
    });

    expect(result.intent).toBe("sensitiveDataPermissionDenied");
    expect(result.tool).toBe("sensitiveDataPermissionDenied");
    expect(result.answer).not.toMatch(/\d{4,}|Demo Owner.*(?:USD|\$)/i);
    expect(routeAssistantDatabaseQuery).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("keeps stock shortage questions on the deterministic stock-needs path", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    routeAssistantDatabaseQuery.mockResolvedValueOnce({
      permissionDenied: false,
      intent: "stock_shortage",
      confidence: 1,
      ambiguous: false,
      plan: {
        intent: "stock_shortage",
        confidence: 1,
        tool: "getStockShortageSummary",
        answerMode: "list",
        language: "es",
        entity: "stock_need",
        metric: null,
        mpn: null,
        requiresClarification: false,
        policyDecision: "allow"
      },
      toolResult: {
        ok: true,
        tool: "getStockShortageSummary",
        scope: "company",
        total: 90,
        rows: [],
        data: { items: [], totals: { noStock: 90 } },
        summary: "Encontré 90 MPN con necesidad y sin stock disponible.",
        empty: false,
        truncated: false,
        deterministic: true
      }
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("admin"),
      message: "Que MPN tienen falta de stock?",
      language: "es",
      channel: "text"
    });

    expect(result.answer).toContain("90 MPN con faltante");
    expect(result.tool).toBe("getStockShortageSummary");
    expect(routeAssistantDatabaseQuery).toHaveBeenCalledWith(
      expect.any(Object),
      "Que MPN tienen falta de stock?",
      { language: "es", jobId: undefined, history: [] }
    );
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("does not send sensitive commercial fields to OpenAI", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    routeAssistantDatabaseQuery.mockResolvedValueOnce({
      permissionDenied: false,
      intent: "general_query",
      confidence: 0.8,
      ambiguous: false,
      plan: {
        intent: "general_query",
        confidence: 0.8,
        tool: "searchBusinessRecords",
        answerMode: "summary",
        language: "es",
        entity: "business_record",
        metric: null,
        mpn: null,
        requiresClarification: false,
        policyDecision: "allow"
      },
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

  it("returns the deterministic safe summary when OpenAI chat fails", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    responsesCreate.mockRejectedValueOnce(new Error("synthetic upstream failure"));

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    const result = await answerAssistantQuestion({
      context: authContext("employee"),
      message: "Busca MPN ABC123",
      language: "es",
      channel: "text"
    });

    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(result.answer).toContain("1 registros autorizados para el MPN ABC123");
    expect(result.answer).not.toContain("Supplier A");
    expect(result.answer).not.toContain("precio");
    expect(result.generatedWithAi).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai_llm_failed",
      metadata: expect.objectContaining({ fallbackUsed: true })
    }));
  });

  it("raises 403 when an employee requests unauthorized company-wide data", async () => {
    routeAssistantDatabaseQuery.mockResolvedValueOnce({
      permissionDenied: true,
      intent: "permission_denied",
      confidence: 1,
      ambiguous: false,
      toolResult: null
    });

    const { answerAssistantQuestion } = await import("@/lib/ai/assistantCore");
    await expect(answerAssistantQuestion({
      context: authContext("employee"),
      message: "Muestra todos los datos de la empresa",
      language: "es",
      channel: "text"
    })).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED"
    });
  });
});
