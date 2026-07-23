import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";

function managerContext(): AuthContext {
  return {
    user: null,
    supabase: null,
    isDemoMode: true,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Demo Manager",
      email: "manager@quiksol.local",
      role: "manager",
      department: "Sales",
      region: "US",
      is_active: true,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString()
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/admin/opportunities",
      traceId: "trace",
      requestId: "request"
    }
  };
}

describe("GET /api/admin/opportunities", () => {
  const requireRole = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
  });

  it("requires admin or manager access and blocks employees through the shared guard", async () => {
    const denied = NextResponse.json({ error: "denied" }, { status: 403 });
    requireRole.mockResolvedValue(denied);
    const request = new Request("https://app.test/api/admin/opportunities");

    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager"]);
  });

  it("allows manager role and returns the safe empty demo result", async () => {
    requireRole.mockResolvedValue(managerContext());
    const request = new Request("https://app.test/api/admin/opportunities?limit=10");

    const { GET } = await import("../route");
    const response = await GET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.items).toEqual([]);
    expect(payload.totals.totalOpportunities).toBe(0);
  });

  it("keeps records active-only through the shared loader and never returns raw rows directly", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/admin/opportunities/route.ts"), "utf8");
    const loader = readFileSync(path.join(process.cwd(), "lib/stock-needs/data-source.ts"), "utf8");

    expect(source).toContain("loadStockNeedsInput");
    expect(loader).toContain('.from("business_records")');
    expect(loader).toContain('.is("archived_at", null)');
    expect(source).toContain("buildSalesOpportunitiesResult");
    expect(source).toContain("redactSensitiveFieldsForRole");
    expect(source).not.toContain("return NextResponse.json({ records");
  });

  it("does not expose cost, price or GP fields from the opportunities endpoint source", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/admin/opportunities/route.ts"), "utf8");
    const helper = readFileSync(path.join(process.cwd(), "lib/opportunities/opportunities.ts"), "utf8");

    expect(source).not.toContain("UNIT COST");
    expect(source).not.toContain("PriceBook");
    expect(source).not.toContain("GlobalPrice");
    expect(source).not.toContain("gp_rate");
    expect(helper).not.toContain("unitCost");
    expect(helper).not.toContain("bestPrice");
    expect(helper).not.toContain("gp_rate");
  });
});
