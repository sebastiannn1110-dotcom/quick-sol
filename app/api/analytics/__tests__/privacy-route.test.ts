import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";

function context(): AuthContext {
  return {
    user: null,
    supabase: { from: vi.fn() } as never,
    isDemoMode: false,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Synthetic Admin",
      email: "synthetic@example.invalid",
      role: "admin",
      department: "Synthetic",
      region: "Test",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "192.0.2.1",
      userAgent: "vitest",
      route: "/api/analytics",
      traceId: "trace",
      requestId: "request"
    }
  };
}

const analytics = {
  totals: { totalRecords: 1, totalUploads: 1, categoriesDetected: 1 },
  recordsByCategory: []
};

describe("GET /api/analytics privacy and integrity", () => {
  const requireAdmin = vi.fn();
  const safeQuery = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue(context());
    safeQuery.mockResolvedValue({ data: [], error: null });
    vi.doMock("@/lib/auth/context", () => ({ requireAdmin }));
    vi.doMock("@/lib/supabase/supabase-safe", () => ({ safeQuery }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/logger/performance", () => ({ measureAsync: async (_a: string, _b: string, _c: unknown, run: () => unknown) => run() }));
    vi.doMock("@/lib/platform/analytics", () => ({ buildPlatformAnalytics: () => analytics }));
  });

  it("returns 403 for an authenticated role without the demonstrated admin capability", async () => {
    requireAdmin.mockResolvedValueOnce(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/analytics"));
    expect(response.status).toBe(403);
    expect(safeQuery).not.toHaveBeenCalled();
  });

  it("returns a real 500 instead of a valid-looking zero payload when a dependency fails", async () => {
    safeQuery.mockResolvedValueOnce({ data: null, error: { code: "DEPENDENCY_FAILED" } });
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/analytics"));
    const payload = await response.json();
    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "Unable to load analytics.", code: "ANALYTICS_UNAVAILABLE" });
    expect(payload).not.toHaveProperty("analytics");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("marks capped results as sampled and partial", async () => {
    safeQuery
      .mockResolvedValueOnce({ data: new Array(5000), error: null })
      .mockResolvedValueOnce({ data: new Array(1000), error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/analytics"));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.meta).toEqual({ partial: true, sampled: true, sampleLimit: { records: 5000, uploads: 1000 } });
  });
});
