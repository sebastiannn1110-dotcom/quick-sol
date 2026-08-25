import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { roleSatisfiesAny } from "@/lib/auth/roles";

describe("GET /api/stock-needs role and summary lifecycle", () => {
  const requireRole = vi.fn();
  const buildStockNeedsResult = vi.fn();
  const redactSensitiveFieldsForRole = vi.fn((value) => value);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
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

  function readyState() {
    return {
      summaryReady: true,
      status: "ready",
      currentVersion: 8,
      requiredVersion: 8,
      retryAfter: null,
      pendingCount: 0,
      totalScopes: 2
    };
  }

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "serves the optimized summary to %s with one preflight and one data RPC",
    async (role) => {
      const context = authContext(role);
      const fastResult = {
        summaryReady: true,
        items: [{ mpn: "SYNTHETIC-ONLY" }],
        totals: { totalItems: 1 },
        meta: { returnedItems: 1 }
      };
      context.supabase.rpc
        .mockResolvedValueOnce({ data: readyState(), error: null })
        .mockResolvedValueOnce({ data: fastResult, error: null });
      requireRole.mockResolvedValue(context);

      const request = new Request("https://app.test/api/stock-needs?limit=100&offset=25");
      const { GET } = await import("../route");
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager", "employee"]);
      expect(roleSatisfiesAny(role, ["admin", "manager", "employee"])).toBe(true);
      expect(context.supabase.rpc).toHaveBeenNthCalledWith(1, "get_business_summary_state_v2", {
        p_upload_batch_id: null,
        p_client_id: null
      });
      expect(context.supabase.rpc).toHaveBeenNthCalledWith(2, "get_stock_needs_page_v1", expect.objectContaining({
        p_limit: 100,
        p_offset: 25
      }));
      expect(context.supabase.rpc).toHaveBeenCalledTimes(2);
      expect(redactSensitiveFieldsForRole).toHaveBeenCalledWith(fastResult, role);
      expect(await response.json()).toEqual(fastResult);
    }
  );

  it.each(["queued", "rebuilding", "retrying", "stale"] as const)(
    "returns bounded HTTP 409 for %s without calling the data RPC or returning false totals",
    async (status) => {
      const context = authContext("manager");
      context.supabase.rpc.mockResolvedValue({
        data: {
          summaryReady: false,
          status,
          currentVersion: 7,
          requiredVersion: 8,
          retryAfter: null,
          pendingCount: 1,
          totalScopes: 2
        },
        error: null
      });
      requireRole.mockResolvedValue(context);

      const { GET } = await import("../route");
      const response = await GET(new Request("https://app.test/api/stock-needs?coverageStatus=no_stock"));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(payload).toMatchObject({
        errorCode: "SUMMARY_NOT_READY",
        summaryStatus: status,
        currentVersion: 7,
        requiredVersion: 8
      });
      expect(payload).not.toHaveProperty("items");
      expect(payload).not.toHaveProperty("totals");
      expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
    }
  );

  it("returns HTTP 503 for a failed rebuild without querying page data", async () => {
    const context = authContext("admin");
    context.supabase.rpc.mockResolvedValue({
      data: { summaryReady: false, status: "failed", currentVersion: 7, requiredVersion: 8 },
      error: null
    });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_REBUILD_FAILED",
      summaryStatus: "failed"
    });
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it.each(["PGRST202", "42883"])("fails closed with HTTP 503 when state contract is unavailable (%s)", async (code) => {
    const context = authContext("employee");
    context.supabase.rpc.mockResolvedValue({ data: null, error: { code } });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_CONTRACT_UNAVAILABLE",
      summaryStatus: "contract_unavailable"
    });
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
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
