import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

function authContext(role: "admin" | "manager" | "employee" = "admin"): AuthContext {
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

describe("AI query router", () => {
  const getRecordsByMpn = vi.fn();
  const getUploadPresentationSummary = vi.fn();
  const searchBusinessRecords = vi.fn();
  const logger = {
    info: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getRecordsByMpn.mockResolvedValue({
      ok: true,
      tool: "getRecordsByMpn",
      scope: "company",
      total: 1,
      rows: [{ mpn: "ABC123" }],
      data: [{ mpn: "ABC123" }],
      summary: "Se encontro ABC123.",
      empty: false
    });
    searchBusinessRecords.mockResolvedValue({
      ok: false,
      tool: "searchBusinessRecords",
      scope: "company",
      total: 0,
      rows: [],
      data: [],
      summary: "Sin resultados.",
      empty: true
    });
    getUploadPresentationSummary.mockResolvedValue({
      ok: true,
      tool: "getUploadPresentationSummary",
      scope: "company",
      total: 1,
      rows: [],
      data: {},
      summary: "El ultimo archivo parece inventario.",
      empty: false,
      deterministic: true
    });
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/ai/database-tools", () => ({
      getDashboardSummary: vi.fn(),
      getEmployeeSummary: vi.fn(),
      getImportErrors: vi.fn(),
      getLatestUpload: vi.fn(),
      getLowGpRecords: vi.fn(),
      getMissingMpnRecords: vi.fn(),
      getMpnPriceComparison: vi.fn(),
      getRecordsByMpn,
      getUploadPresentationSummary,
      getUploadsByUser: vi.fn(),
      searchBusinessRecords
    }));
  });

  it("routes explicit MPN questions to controlled MPN lookup", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), "Busca MPN ABC123");

    expect(result.toolResult?.tool).toBe("getRecordsByMpn");
    expect(getRecordsByMpn).toHaveBeenCalledWith(expect.any(Object), "ABC123");
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });

  it("denies company-wide questions for employees before querying tools", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("employee"), "Show all records company wide");

    expect(result.permissionDenied).toBe(true);
    expect(getRecordsByMpn).not.toHaveBeenCalled();
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });

  it("routes upload presentation questions to the deterministic upload summary", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), "Que campos detectaste como MPN proveedor cantidad costo en el ultimo archivo?");

    expect(result.toolResult?.tool).toBe("getUploadPresentationSummary");
    expect(getUploadPresentationSummary).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("MPN"));
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });
});
