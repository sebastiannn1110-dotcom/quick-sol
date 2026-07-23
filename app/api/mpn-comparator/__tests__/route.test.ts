import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import { MpnLookupError } from "@/lib/mpn/lookup";

function authContext(role: "admin" | "manager" | "employee" = "admin"): AuthContext {
  return {
    user: null,
    supabase: {} as never,
    isDemoMode: false,
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
      route: "/api/mpn-comparator",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("GET /api/mpn-comparator", () => {
  const getAuthContext = vi.fn();
  const loadMpnComparatorOffers = vi.fn();
  const logger = {
    info: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue(authContext("admin"));
    loadMpnComparatorOffers.mockResolvedValue([]);
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/mpn/lookup", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/mpn/lookup")>();
      return { ...actual, MpnLookupError, loadMpnComparatorOffers };
    });
  });

  it("passes exact numeric MPNs as strings and keeps the response MPN unformatted", async () => {
    loadMpnComparatorOffers.mockResolvedValueOnce([{ id: "1", mpn: "1,748,917", supplier_name: "Supplier A", created_at: "2026-07-23T00:00:00Z" }]);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/mpn-comparator?mpn=1748917"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(loadMpnComparatorOffers).toHaveBeenCalledWith(expect.any(Object), "1748917");
    expect(payload.mpn).toBe("1748917");
    expect(payload.mpn).not.toBe("1,748,917");
    expect(payload.offers[0].mpn).toBe("1748917");
    expect(JSON.stringify(payload)).not.toContain("1,748,917");
  });

  it("preserves leading zeroes and letters with dashes in MPN input", async () => {
    const { GET } = await import("../route");

    const leadingZeroResponse = await GET(new Request("https://app.test/api/mpn-comparator?mpn=001234"));
    const leadingZeroPayload = await leadingZeroResponse.json();
    expect(leadingZeroPayload.mpn).toBe("001234");

    const alphaResponse = await GET(new Request("https://app.test/api/mpn-comparator?mpn=ABC-001"));
    const alphaPayload = await alphaResponse.json();
    expect(alphaPayload.mpn).toBe("ABC-001");
  });

  it("redacts sensitive price, cost and GP fields for managers", async () => {
    getAuthContext.mockResolvedValueOnce(authContext("manager"));
    loadMpnComparatorOffers.mockResolvedValueOnce([
      {
        id: "1",
        mpn: "ABC-001",
        supplier_name: "Supplier A",
        price: 10,
        cost: 7,
        gp: 3,
        gp_rate: 0.3,
        created_at: "2026-07-23T00:00:00Z"
      }
    ]);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/mpn-comparator?mpn=ABC-001"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary.bestPrice).toBeNull();
    expect(payload.summary.recommendationReason).toBe("Hay registros visibles para este MPN. Los precios, costos y margen estan ocultos para tu rol.");
    expect(payload.priceHistory).toEqual([]);
    expect(payload.offers[0].price).toBeNull();
    expect(payload.offers[0].cost).toBeNull();
    expect(payload.offers[0].gp).toBeNull();
    expect(payload.offers[0].gp_rate).toBeNull();
  });

  it("turns database statement timeouts into a controlled safe response", async () => {
    loadMpnComparatorOffers.mockRejectedValueOnce(new MpnLookupError("mpn_exact", {
      code: "57014",
      message: "canceling statement due to statement timeout"
    }));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/mpn-comparator?mpn=1748917"));
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.error).toBe("La busqueda del MPN tardo demasiado. Intenta con un MPN exacto.");
    expect(payload.error).not.toMatch(/57014|statement timeout|Supabase|SQL/i);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "mpn_comparison_failed",
      durationMs: expect.any(Number),
      metadata: expect.objectContaining({ mpn: "1748917", stage: "mpn_exact", timeout: true })
    }));
  });
});
