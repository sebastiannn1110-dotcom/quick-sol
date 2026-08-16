import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  logAuditEvent: vi.fn(),
  getDemoPlatformData: vi.fn(async () => ({ profiles: [] }))
}));

vi.mock("@/lib/auth/context", () => ({
  requireAdmin: mocks.requireAdmin,
  logAuditEvent: mocks.logAuditEvent
}));

vi.mock("@/lib/platform/demoRepository", () => ({
  getDemoPlatformData: mocks.getDemoPlatformData
}));

import { GET, PATCH } from "@/app/api/admin/users/route";

function context(role: "admin" | "super_admin_dev", overrides: Record<string, unknown> = {}) {
  return {
    profile: { id: "00000000-0000-4000-8000-000000000001", role },
    isDemoMode: true,
    supabase: null,
    ...overrides
  };
}

describe("admin user management role inheritance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets Super Admin Dev use the normal admin users endpoint", async () => {
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev"));
    const response = await GET(new Request("https://app.test/api/admin/users"));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
  });

  it("does not let the admin screen demote the current Super Admin Dev", async () => {
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev"));
    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000001", role: "admin" })
    }));
    expect(response.status).toBe(403);
  });

  it("prevents a normal admin from modifying a Super Admin Dev profile", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "super_admin_dev" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = { from: vi.fn(() => builder) };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000002", email: "replacement@example.test" })
    }));

    expect(response.status).toBe(403);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });
});
