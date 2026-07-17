import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("GET /api/admin/stock-needs", () => {
  const requireRole = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
  });

  it("requires admin or manager access", async () => {
    const denied = NextResponse.json({ error: "denied" }, { status: 403 });
    requireRole.mockResolvedValue(denied);
    const request = new Request("https://app.test/api/admin/stock-needs");

    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager"]);
  });

  it("keeps the business record query active-only and does not return raw rows directly", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/admin/stock-needs/route.ts"), "utf8");

    expect(source).toContain('.from("business_records")');
    expect(source).toContain('.is("archived_at", null)');
    expect(source).toContain("buildStockNeedsResult");
    expect(source).not.toContain("return NextResponse.json({ records");
  });
});
