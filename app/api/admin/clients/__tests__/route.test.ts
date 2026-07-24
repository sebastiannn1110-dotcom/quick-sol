import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /api/admin/clients", () => {
  const requireRole = vi.fn();
  const logAuditEvent = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole, logAuditEvent }));
  });

  it("blocks employee writes through the backend role guard", async () => {
    requireRole.mockResolvedValue(NextResponse.json({ error: "denied" }, { status: 403 }));
    const request = new Request("https://app.test/api/admin/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic Account" })
    });
    const { POST } = await import("../route");
    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager"]);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
