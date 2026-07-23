import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import { MpnLookupError } from "@/lib/mpn/lookup";

function authContext(): AuthContext {
  return {
    user: null,
    supabase: {} as never,
    isDemoMode: false,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Demo User",
      email: "demo@quiksol.local",
      role: "admin",
      department: "Sales",
      region: "US",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/mpn-comparator/suggest",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("GET /api/mpn-comparator/suggest", () => {
  const getAuthContext = vi.fn();
  const loadMpnSuggestions = vi.fn();
  const logger = {
    error: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue(authContext());
    loadMpnSuggestions.mockResolvedValue(["1748917"]);
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/mpn/lookup", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/mpn/lookup")>();
      return { ...actual, MpnLookupError, loadMpnSuggestions };
    });
  });

  it("does not execute a lookup for empty or too-short suggestions", async () => {
    const { GET } = await import("../route");

    const emptyResponse = await GET(new Request("https://app.test/api/mpn-comparator/suggest?q="));
    const shortResponse = await GET(new Request("https://app.test/api/mpn-comparator/suggest?q=12"));

    expect(await emptyResponse.json()).toEqual({ suggestions: [] });
    expect(await shortResponse.json()).toEqual({ suggestions: [] });
    expect(loadMpnSuggestions).not.toHaveBeenCalled();
  });

  it("returns limited suggestions from the bounded lookup helper", async () => {
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/mpn-comparator/suggest?q=1748917"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(loadMpnSuggestions).toHaveBeenCalledWith(expect.any(Object), "1748917");
    expect(payload.suggestions).toEqual(["1748917"]);
  });

  it("turns suggestion statement timeouts into a controlled safe response", async () => {
    loadMpnSuggestions.mockRejectedValueOnce(new MpnLookupError("mpn_suggest", {
      code: "57014",
      message: "canceling statement due to statement timeout"
    }));

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/mpn-comparator/suggest?q=1748917"));
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.error).toBe("La busqueda de sugerencias tardo demasiado. Escribe un MPN mas especifico.");
    expect(payload.error).not.toMatch(/57014|statement timeout|Supabase|SQL/i);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "mpn_suggestions_failed",
      durationMs: expect.any(Number),
      metadata: expect.objectContaining({ q: "1748917", stage: "mpn_suggest", timeout: true })
    }));
  });
});
