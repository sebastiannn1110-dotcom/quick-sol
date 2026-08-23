import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { roleSatisfiesAny } from "@/lib/auth/roles";

describe("GET /api/stock-needs role and fast-path lifecycle", () => {
  const requireRole = vi.fn();
  const loadStockNeedsInput = vi.fn();
  const buildStockNeedsResult = vi.fn();
  const redactSensitiveFieldsForRole = vi.fn((value) => value);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
    vi.doMock("@/lib/stock-needs/data-source", () => ({ loadStockNeedsInput }));
    vi.doMock("@/lib/stock-needs/stock-needs", () => ({ buildStockNeedsResult }));
    vi.doMock("@/lib/security/permissions", () => ({ redactSensitiveFieldsForRole }));
  });

  function authContext(role: "employee" | "manager" | "admin" | "super_admin_dev") {
    return {
      profile: { id: `${role}-id`, role },
      isDemoMode: false,
      supabase: { rpc: vi.fn() }
    };
  }

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "serves the optimized summary to %s without widening scope or using the fallback",
    async (role) => {
      const context = authContext(role);
      const fastResult = {
        summaryReady: true,
        items: [{ mpn: "VISIBLE-ONLY" }],
        totals: { totalItems: 1 },
        meta: { returnedItems: 1 }
      };
      context.supabase.rpc.mockResolvedValue({ data: fastResult, error: null });
      requireRole.mockResolvedValue(context);

      const request = new Request("https://app.test/api/stock-needs?limit=100&offset=25");
      const { GET } = await import("../route");
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager", "employee"]);
      expect(roleSatisfiesAny(role, ["admin", "manager", "employee"])).toBe(true);
      expect(context.supabase.rpc).toHaveBeenCalledWith("get_stock_needs_page_v1", expect.objectContaining({
        p_limit: 100,
        p_offset: 25
      }));
      expect(redactSensitiveFieldsForRole).toHaveBeenCalledWith(fastResult, role);
      expect(loadStockNeedsInput).not.toHaveBeenCalled();
      expect(await response.json()).toEqual(fastResult);
    }
  );

  it("keeps the exact fallback for a not-ready summary", async () => {
    const context = authContext("manager");
    context.supabase.rpc.mockResolvedValue({ data: { summaryReady: false }, error: null });
    requireRole.mockResolvedValue(context);
    const fallbackInput = { records: [], profiles: [], importJobs: [], uploadIds: [] };
    const fallbackResult = { items: [], totals: { totalItems: 0 }, meta: { returnedItems: 0 } };
    loadStockNeedsInput.mockResolvedValue(fallbackInput);
    buildStockNeedsResult.mockReturnValue(fallbackResult);

    const request = new Request("https://app.test/api/stock-needs?coverageStatus=no_stock");
    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(loadStockNeedsInput).toHaveBeenCalledWith(context.supabase, expect.objectContaining({
      complete: true,
      maxUploads: 20
    }));
    expect(buildStockNeedsResult).toHaveBeenCalledWith(expect.objectContaining({
      records: fallbackInput.records,
      profiles: fallbackInput.profiles,
      importJobs: fallbackInput.importJobs,
      filters: expect.objectContaining({ coverageStatus: "no_stock" })
    }));
    expect(await response.json()).toEqual(fallbackResult);
  });

  it("does not hide a fast-path timeout behind an automatic full scan", async () => {
    const context = authContext("admin");
    context.supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" }
    });
    requireRole.mockResolvedValue(context);

    const request = new Request("https://app.test/api/stock-needs?limit=100");
    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(500);
    expect(loadStockNeedsInput).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "Unable to load stock and needs." });
  });

  it("uses the compatibility fallback only when the RPC is not installed", async () => {
    const context = authContext("employee");
    context.supabase.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    requireRole.mockResolvedValue(context);
    loadStockNeedsInput.mockResolvedValue({ records: [], profiles: [], importJobs: [], uploadIds: [] });
    buildStockNeedsResult.mockReturnValue({ items: [], totals: {}, meta: {} });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(200);
    expect(loadStockNeedsInput).toHaveBeenCalledOnce();
  });

  it("preserves the role guard response", async () => {
    const denied = NextResponse.json({ error: "denied" }, { status: 403 });
    requireRole.mockResolvedValue(denied);

    const request = new Request("https://app.test/api/stock-needs");
    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager", "employee"]);
  });
});
