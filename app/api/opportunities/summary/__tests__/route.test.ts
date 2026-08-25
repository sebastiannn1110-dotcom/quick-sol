import { beforeEach, describe, expect, it, vi } from "vitest";

describe("GET /api/opportunities/summary", () => {
  const getAuthContext = vi.fn();
  const redactSensitiveFieldsForRole = vi.fn((value) => value);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/security/permissions", () => ({ redactSensitiveFieldsForRole }));
  });

  function context(rpc: ReturnType<typeof vi.fn>, role = "employee") {
    return {
      profile: { id: "actor", role },
      isDemoMode: false,
      supabase: { rpc }
    };
  }

  it.each(["employee", "manager", "admin", "super_admin_dev"])("returns the ready rollup to %s", async (role) => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 9, requiredVersion: 9 }, error: null })
      .mockResolvedValueOnce({
        data: {
          ready: true,
          data_version: 9,
          total_opportunities: 2,
          immediate_sale: 1,
          partial_sale: 1,
          excess_resale: 0,
          sourcing_needed: 0,
          stock_without_demand: 0,
          approved_part_matches: 0,
          received_history_matches: 0
        },
        error: null
      });
    getAuthContext.mockResolvedValue(context(rpc, role));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities/summary"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(rpc).toHaveBeenNthCalledWith(1, "get_business_summary_state_v2", {
      p_upload_batch_id: null,
      p_client_id: null
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_opportunity_summary_v1");
    expect(await response.json()).toMatchObject({
      totals: { totalOpportunities: 2, immediateSale: 1, partialSale: 1 },
      dataVersion: 9,
      source: "versioned_summary"
    });
  });

  it("returns HTTP 409 and no totals while the summary is queued", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { summaryReady: false, status: "queued", currentVersion: 8, requiredVersion: 9 },
      error: null
    });
    getAuthContext.mockResolvedValue(context(rpc));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities/summary"));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({ errorCode: "SUMMARY_NOT_READY", summaryStatus: "queued" });
    expect(payload).not.toHaveProperty("totals");
  });

  it("fails closed if the legacy rollup turns stale after a ready preflight", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 9, requiredVersion: 9 }, error: null })
      .mockResolvedValueOnce({ data: { ready: false, data_version: 9 }, error: null });
    getAuthContext.mockResolvedValue(context(rpc));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities/summary"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: "SUMMARY_NOT_READY", summaryStatus: "stale" });
  });

  it("returns HTTP 503 when the state contract is unavailable", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "42883" } });
    getAuthContext.mockResolvedValue(context(rpc));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/opportunities/summary"));

    expect(response.status).toBe(503);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ errorCode: "SUMMARY_CONTRACT_UNAVAILABLE" });
  });
});
