import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

function employeeContext(): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "00000000-0000-4000-8000-000000000003",
      full_name: "Demo Employee",
      email: "employee@quiksol.local",
      role: "employee",
      department: "Sales",
      region: "US",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/opportunities",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("GET /api/opportunities", () => {
  const getAuthContext = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  it("allows an authenticated employee to query the shared opportunities endpoint", async () => {
    getAuthContext.mockResolvedValue(employeeContext());
    const request = new Request("https://app.test/api/opportunities?limit=10");
    const { GET } = await import("../route");
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.items).toEqual([]);
    expect(payload.totals.totalOpportunities).toBe(0);
  });

  it("returns the authentication response without running opportunity work", async () => {
    getAuthContext.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities"));
    expect(response.status).toBe(401);
  });

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "uses the state preflight and summary page for %s without scanning records",
    async (role) => {
      const rpc = vi.fn()
        .mockResolvedValueOnce({
          data: { summaryReady: true, status: "ready", currentVersion: 4, requiredVersion: 4 },
          error: null
        })
        .mockResolvedValueOnce({
          data: {
            summaryReady: true,
            items: [],
            totals: {
              totalOpportunities: 0,
              immediateSale: 0,
              partialSale: 0,
              excessResale: 0,
              sourcingNeeded: 0,
              stockWithoutDemand: 0,
              approvedPartMatches: 0,
              receivedHistoryMatches: 0
            },
            meta: { limit: 50, offset: 0, returnedItems: 0, scannedRecords: 0, scannedUploads: 0, totalBeforePagination: 0 }
          },
          error: null
        });
      getAuthContext.mockResolvedValue({
        ...employeeContext(),
        isDemoMode: false,
        profile: { ...employeeContext().profile, role },
        supabase: { rpc, from: vi.fn(() => { throw new Error("RAW_SCAN_NOT_ALLOWED"); }) }
      });

      const { GET } = await import("../route");
      const response = await GET(new Request("https://app.test/api/opportunities"));

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc).toHaveBeenNthCalledWith(1, "get_business_summary_state_v2", {
        p_upload_batch_id: null,
        p_client_id: null
      });
      expect(rpc).toHaveBeenNthCalledWith(2, "get_sales_opportunities_page_v1", expect.any(Object));
      expect(await response.json()).not.toHaveProperty("raw_data");
    }
  );

  it.each(["queued", "rebuilding", "retrying", "stale"] as const)(
    "returns HTTP 409 for %s without invoking the opportunity page",
    async (status) => {
      const rpc = vi.fn().mockResolvedValue({
        data: { summaryReady: false, status, currentVersion: 4, requiredVersion: 5 },
        error: null
      });
      getAuthContext.mockResolvedValue({
        ...employeeContext(),
        isDemoMode: false,
        supabase: { rpc, from: vi.fn(() => { throw new Error("RAW_SCAN_NOT_ALLOWED"); }) }
      });

      const { GET } = await import("../route");
      const response = await GET(new Request("https://app.test/api/opportunities"));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(payload).toMatchObject({ errorCode: "SUMMARY_NOT_READY", summaryStatus: status });
      expect(payload).not.toHaveProperty("items");
      expect(payload).not.toHaveProperty("totals");
    }
  );

  it("returns HTTP 503 when the state RPC contract is unavailable", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    getAuthContext.mockResolvedValue({
      ...employeeContext(),
      isDemoMode: false,
      supabase: { rpc, from: vi.fn(() => { throw new Error("RAW_SCAN_NOT_ALLOWED"); }) }
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities"));

    expect(response.status).toBe(503);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_CONTRACT_UNAVAILABLE",
      summaryStatus: "contract_unavailable"
    });
  });

  it("fails closed when a write dirties the summary between preflight and page read", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { summaryReady: true, status: "ready", currentVersion: 4, requiredVersion: 4 },
        error: null
      })
      .mockResolvedValueOnce({
        data: {
          summaryReady: false,
          status: "stale",
          items: [],
          totals: { totalOpportunities: 0 }
        },
        error: null
      });
    getAuthContext.mockResolvedValue({
      ...employeeContext(),
      isDemoMode: false,
      supabase: { rpc, from: vi.fn(() => { throw new Error("RAW_SCAN_NOT_ALLOWED"); }) }
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities"));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({ errorCode: "SUMMARY_NOT_READY", summaryStatus: "stale" });
    expect(payload).not.toHaveProperty("items");
    expect(payload).not.toHaveProperty("totals");
  });
});
