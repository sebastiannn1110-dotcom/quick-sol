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
});
