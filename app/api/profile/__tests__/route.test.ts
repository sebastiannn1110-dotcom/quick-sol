import { beforeEach, describe, expect, it, vi } from "vitest";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Quiksol Employee",
  email: "employee@quiksol.local",
  role: "employee",
  department: "Sales",
  region: "Global",
  is_active: true,
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:00:00.000Z"
};

describe("PATCH /api/profile", () => {
  const getAuthContext = vi.fn();
  const logAuditEvent = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext, logAuditEvent }));
  });

  it("updates public profile fields without allowing role changes", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: { ...profile, bio: "Compras internacionales", job_title: "Buyer" },
        error: null
      }))
    };
    getAuthContext.mockResolvedValue({
      user: null,
      profile,
      supabase,
      isDemoMode: false,
      requestMeta: { ipAddress: "127.0.0.1", userAgent: "vitest", route: "/api/profile", traceId: "trace", requestId: "request" }
    });

    const { PATCH } = await import("../route");
    const response = await PATCH(new Request("https://app.test/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bio: "Compras internacionales", job_title: "Buyer", role: "admin" })
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.profile.job_title).toBe("Buyer");
    expect(supabase.rpc).toHaveBeenCalledWith("update_my_profile_public", {
      new_bio: "Compras internacionales",
      new_job_title: "Buyer"
    });
  });
});
