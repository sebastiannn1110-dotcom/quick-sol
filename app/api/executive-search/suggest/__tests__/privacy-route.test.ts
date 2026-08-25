import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/auth/context";
import type { UserRole } from "@/lib/types";

const queryCalls: Array<{ table: string; select?: string; filter?: string }> = [];

function supabase() {
  return {
    from(table: string) {
      const call = { table } as { table: string; select?: string; filter?: string };
      queryCalls.push(call);
      const builder = {
        select(value: string) { call.select = value; return builder; },
        is() { return builder; },
        or(value: string) { call.filter = value; return builder; },
        limit() {
          return Promise.resolve({
            data: [{
              mpn: "SYN-MPN-1",
              mpn_quoted: null,
              category: "Synthetic",
              supplier: "SYN-SUPPLIER",
              supplier_name: null,
              customer: "SYN-CUSTOMER",
              client: null,
              po: "SYN-PO",
              price: 999,
              gp_rate: 0.9,
              id: "00000000-0000-4000-8000-000000000099"
            }],
            error: null
          });
        }
      };
      return builder;
    }
  };
}

function context(role: UserRole): AuthContext {
  return {
    user: null,
    supabase: supabase() as never,
    isDemoMode: false,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Synthetic User",
      email: "synthetic@example.invalid",
      role,
      department: "Synthetic",
      region: "Test",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: { ipAddress: "192.0.2.1", userAgent: "vitest", route: "/api/executive-search/suggest", traceId: "trace", requestId: "request" }
  };
}

describe("GET /api/executive-search/suggest privacy", () => {
  const getAuthContext = vi.fn();
  const logger = { warn: vi.fn() };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    queryCalls.length = 0;
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
  });

  it("returns 401 without a valid session", async () => {
    getAuthContext.mockResolvedValueOnce(NextResponse.json({ error: "Authentication required" }, { status: 401 }));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/executive-search/suggest?q=SYN"));
    expect(response.status).toBe(401);
    expect(queryCalls).toHaveLength(0);
  });

  it.each([
    ["employee", false],
    ["manager", true],
    ["admin", true],
    ["super_admin_dev", true]
  ] as const)("applies the output allowlist for %s", async (role, seesParties) => {
    getAuthContext.mockResolvedValueOnce(context(role));
    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/executive-search/suggest?q=SYN"));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.groups.mpn).toHaveLength(1);
    expect(payload.groups.supplier.length > 0).toBe(seesParties);
    expect(payload.groups.customer.length > 0).toBe(seesParties);
    expect(payload.groups.po).toEqual([]);
    expect(payload.groups.financial).toEqual([]);
    expect(serialized).not.toContain("SYN-PO");
    expect(serialized).not.toContain("999");
    expect(serialized).not.toContain("0.9");
    expect(serialized).not.toContain("00000000-0000-4000-8000-000000000099");
    expect(queryCalls[0].select).not.toMatch(/\b(?:id|po|price|gp_rate)\b/);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
