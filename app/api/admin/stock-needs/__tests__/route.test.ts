import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("GET /api/admin/stock-needs", () => {
  const requireRole = vi.fn();
  const buildStockNeedsResult = vi.fn();
  const redactSensitiveFieldsForRole = vi.fn((value) => value);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
    vi.doMock("@/lib/stock-needs/stock-needs", () => ({ buildStockNeedsResult }));
    vi.doMock("@/lib/security/permissions", () => ({ redactSensitiveFieldsForRole }));
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

  it.each(["manager", "admin", "super_admin_dev"])("uses only state + summary RPC for %s", async (role) => {
    const page = { summaryReady: true, items: [], totals: { totalItems: 0 }, meta: {} };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 3, requiredVersion: 3 }, error: null })
      .mockResolvedValueOnce({ data: page, error: null });
    requireRole.mockResolvedValue({ profile: { id: "actor", role }, isDemoMode: false, supabase: { rpc } });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/admin/stock-needs"));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_business_summary_state_v2", {
      p_upload_batch_id: null,
      p_client_id: null
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_stock_needs_page_v1", expect.any(Object));
    expect(redactSensitiveFieldsForRole).toHaveBeenCalledWith(page, role);
  });

  it("returns lifecycle status without invoking the page RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { summaryReady: false, status: "rebuilding", currentVersion: 2, requiredVersion: 3 },
      error: null
    });
    requireRole.mockResolvedValue({ profile: { id: "actor", role: "manager" }, isDemoMode: false, supabase: { rpc } });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/admin/stock-needs"));

    expect(response.status).toBe(409);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_NOT_READY",
      summaryStatus: "rebuilding"
    });
  });

  it("contains no user-facing raw-row or compatibility fallback path", () => {
    const source = readFileSync(path.join(process.cwd(), "app/api/admin/stock-needs/route.ts"), "utf8");

    expect(source).toContain("requireBusinessSummaryReady");
    expect(source).toContain("get_stock_needs_page_v1");
    expect(source).not.toContain("loadStockNeedsInput");
    expect(source).not.toContain("complete: true");
    expect(source).not.toContain('from("business_records")');
    expect(source).not.toContain("raw_data");
    expect(source).not.toContain("normalized_data");
  });
});
