import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  logAuditEvent: vi.fn(),
  getDemoPlatformData: vi.fn(async () => ({ profiles: [] })),
  createSupabaseAdminClient: vi.fn()
}));

vi.mock("@/lib/auth/context", () => ({
  requireAdmin: mocks.requireAdmin,
  logAuditEvent: mocks.logAuditEvent
}));

vi.mock("@/lib/platform/demoRepository", () => ({
  getDemoPlatformData: mocks.getDemoPlatformData
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient
}));

import { GET, PATCH, POST } from "@/app/api/admin/users/route";

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

  it("rejects a normal admin attempting to create or promote Super Admin Dev", async () => {
    mocks.requireAdmin.mockResolvedValue(context("admin"));
    const createResponse = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "privileged@example.test",
        full_name: "Privileged Target",
        role: "super_admin_dev"
      })
    }));
    const promoteResponse = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000002",
        role: "super_admin_dev"
      })
    }));

    expect(createResponse.status).toBe(403);
    expect(promoteResponse.status).toBe(403);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("lets Super Admin Dev create a privileged profile through the explicit audited API", async () => {
    const profileBuilder = {
      upsert: vi.fn(),
      select: vi.fn(),
      single: vi.fn(async () => ({
        data: { id: "00000000-0000-4000-8000-000000000007", role: "super_admin_dev" },
        error: null
      }))
    };
    profileBuilder.upsert.mockReturnValue(profileBuilder);
    profileBuilder.select.mockReturnValue(profileBuilder);
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: { id: "00000000-0000-4000-8000-000000000007" } },
            error: null
          }))
        }
      },
      from: vi.fn(() => profileBuilder)
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev", { isDemoMode: false }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "privileged@example.test",
        full_name: "Privileged Target",
        role: "super_admin_dev"
      })
    }));

    expect(response.status).toBe(200);
    expect(service.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      user_metadata: { full_name: "Privileged Target" }
    }));
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "superadmin_created_privileged_user",
      "profile",
      "00000000-0000-4000-8000-000000000007",
      expect.objectContaining({ role: "super_admin_dev" })
    );
  });

  it("routes a Super Admin Dev promotion through the audited database RPC", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null })),
      in: vi.fn()
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    builder.in.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: { id: "00000000-0000-4000-8000-000000000008", role: "super_admin_dev" },
        error: null
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev", {
      isDemoMode: false,
      supabase
    }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000008",
        role: "super_admin_dev"
      })
    }));

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v1", {
      target_profile_id: "00000000-0000-4000-8000-000000000008",
      profile_patch: { role: "super_admin_dev" },
      confirm_self_deactivate: false
    });
  });
});
