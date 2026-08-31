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

  it("assigns a manager-created client to that manager", async () => {
    const managerId = "11111111-1111-4111-8111-111111111111";
    const single = vi.fn().mockResolvedValue({
      data: { id: "22222222-2222-4222-8222-222222222222", name: "Synthetic Account" },
      error: null
    });
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ insert }));
    requireRole.mockResolvedValue({
      profile: { id: managerId, role: "manager" },
      isDemoMode: false,
      supabase: { from }
    });

    const request = new Request("https://app.test/api/admin/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Synthetic Account" })
    });
    const { POST } = await import("../route");
    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(from).toHaveBeenCalledWith("clients");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      created_by: managerId,
      updated_by: managerId,
      assigned_salesperson_id: managerId
    }));
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ id: managerId }) }),
      "client_created",
      "client",
      "22222222-2222-4222-8222-222222222222"
    );
  });
});
