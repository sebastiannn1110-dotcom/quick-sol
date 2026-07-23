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
  const getStockNeedsSummary = vi.fn();
  const getUploadPresentationSummary = vi.fn();
  const getSensitiveDataPermissionDenied = vi.fn();
  const getLowGpRecords = vi.fn();
  const getMpnPriceComparison = vi.fn();
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
    getStockNeedsSummary.mockResolvedValue({
      ok: true,
      tool: "getStockNeedsSummary",
      scope: "company",
      total: 1,
      rows: [],
      data: { items: [], totals: {} },
      summary: "Para ABC123: necesidad 5, stock 3, cobertura partial stock.",
      empty: false,
      deterministic: true
    });
    getSensitiveDataPermissionDenied.mockImplementation((context: AuthContext) => ({
      ok: true,
      tool: "sensitiveDataPermissionDenied",
      scope: context.profile.role === "admin" ? "company" : context.profile.role === "manager" ? "team" : "own",
      data: { reason: "sensitive_fields_restricted" },
      summary: "No tengo permiso para mostrar costos, precios o margen en esta vista.",
      empty: false,
      deterministic: true
    }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/ai/database-tools", () => ({
      getDashboardSummary: vi.fn(),
      getEmployeeSummary: vi.fn(),
      getImportErrors: vi.fn(),
      getLatestUpload: vi.fn(),
      getLowGpRecords,
      getMissingMpnRecords: vi.fn(),
      getMpnPriceComparison,
      getRecordsByMpn,
      getSensitiveDataPermissionDenied,
      getStockNeedsSummary,
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

  it("returns a clean permission message for restricted sensitive data questions", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("manager"), "Cual es el costo y GP rate de este MPN ABC123?");

    expect(result.permissionDenied).toBe(false);
    expect(result.toolResult?.tool).toBe("sensitiveDataPermissionDenied");
    expect(result.toolResult?.summary).toBe("No tengo permiso para mostrar costos, precios o margen en esta vista.");
    expect(getSensitiveDataPermissionDenied).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ role: "manager" }) }));
    expect(getLowGpRecords).not.toHaveBeenCalled();
    expect(getMpnPriceComparison).not.toHaveBeenCalled();
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });

  it.each([
    "Muestrame los costos de los MPN",
    "Que GP rate tenemos",
    "Muestrame precios y margenes"
  ])("blocks sensitive production phrase before heavy tools: %s", async (question) => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), question);

    expect(result.permissionDenied).toBe(false);
    expect(result.toolResult?.tool).toBe("sensitiveDataPermissionDenied");
    expect(result.toolResult?.summary).toBe("No tengo permiso para mostrar costos, precios o margen en esta vista.");
    expect(getSensitiveDataPermissionDenied).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ role: "admin" }) }));
    expect(getStockNeedsSummary).not.toHaveBeenCalled();
    expect(getLowGpRecords).not.toHaveBeenCalled();
    expect(getMpnPriceComparison).not.toHaveBeenCalled();
    expect(getRecordsByMpn).not.toHaveBeenCalled();
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });

  it("blocks price questions for employees before data tools run", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("employee"), "Muestrame el mejor precio para ABC123");

    expect(result.toolResult?.tool).toBe("sensitiveDataPermissionDenied");
    expect(getSensitiveDataPermissionDenied).toHaveBeenCalled();
    expect(getMpnPriceComparison).not.toHaveBeenCalled();
    expect(getRecordsByMpn).not.toHaveBeenCalled();
  });

  it("routes stock and needs questions to the deterministic stock-needs summary", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), "Que stock tenemos para el MPN ABC123?");

    expect(result.toolResult?.tool).toBe("getStockNeedsSummary");
    expect(getStockNeedsSummary).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("ABC123"), "ABC123");
    expect(getRecordsByMpn).not.toHaveBeenCalled();
  });

  it("does not treat generic Spanish words after MPN as a concrete part number", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), "Que MPN tienen falta de stock?");

    expect(result.toolResult?.tool).toBe("getStockNeedsSummary");
    expect(getStockNeedsSummary).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("falta de stock"), "");
    expect(getRecordsByMpn).not.toHaveBeenCalled();
  });

  it("routes reference shortage questions to stock-needs", async () => {
    const { routeAssistantDatabaseQuery } = await import("@/lib/ai/ai-query-router");
    const result = await routeAssistantDatabaseQuery(authContext("admin"), "Que referencias no tienen stock?");

    expect(result.toolResult?.tool).toBe("getStockNeedsSummary");
    expect(getStockNeedsSummary).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining("referencias"), "");
    expect(searchBusinessRecords).not.toHaveBeenCalled();
  });
});
