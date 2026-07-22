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
    const loader = readFileSync(path.join(process.cwd(), "lib/stock-needs/data-source.ts"), "utf8");

    expect(source).toContain("loadStockNeedsInput");
    expect(loader).toContain('.from("business_records")');
    expect(loader).toContain('.is("archived_at", null)');
    expect(loader).toContain('.eq("upload_batch_id", uploadId)');
    expect(source).toContain("buildStockNeedsResult");
    expect(source).not.toContain("return NextResponse.json({ records");
  });

  it("loads records by upload batch instead of a single global recent-row window", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/admin/stock-needs/route.ts"), "utf8");
    const loader = readFileSync(path.join(process.cwd(), "lib/stock-needs/data-source.ts"), "utf8");

    expect(source).not.toContain("scanLimit");
    expect(loader).toContain("loadVisibleUploadIds");
    expect(loader).toContain("Promise.all(uploadIds.map");
  });
});
