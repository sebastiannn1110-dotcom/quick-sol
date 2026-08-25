import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: { from: vi.fn() }
}));

vi.mock("@/lib/auth/context", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => mocks.service }));

import { assertCriticalSameOrigin, requireSuperadmin, SUPER_ADMIN_DEV_ROLE } from "@/lib/superadmin/auth";

function denied(status: number) {
  return NextResponse.json({ error: status === 401 ? "Authentication required" : "Forbidden" }, { status });
}

const context = {
  user: { id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" },
  profile: { id: "00000000-0000-4000-8000-000000000001", role: SUPER_ADMIN_DEV_ROLE, is_active: true },
  supabase: { auth: {} },
  isDemoMode: false,
  requestMeta: { ipAddress: "127.0.0.1", userAgent: "test", route: "/api/admindev/database-safety/status", traceId: "t", requestId: "r" }
};

describe("Super Admin Dev authorization", () => {
  beforeEach(() => mocks.requireRole.mockReset());

  it.each(["employee", "manager", "admin"])("blocks the %s role with 403", async () => {
    mocks.requireRole.mockResolvedValue(denied(403));
    const response = await requireSuperadmin(new Request("https://example.test/api/admindev/database-safety/status"));
    expect(response).toBeInstanceOf(NextResponse);
    expect((response as NextResponse).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith(expect.any(Request), [SUPER_ADMIN_DEV_ROLE]);
  });

  it("blocks direct unauthenticated API access with 401", async () => {
    mocks.requireRole.mockResolvedValue(denied(401));
    const response = await requireSuperadmin(new Request("https://example.test/api/admindev/database-safety/status"));
    expect((response as NextResponse).status).toBe(401);
  });

  it("allows only an active authenticated Super Admin Dev context", async () => {
    mocks.requireRole.mockResolvedValue(context);
    const allowed = await requireSuperadmin(new Request("https://example.test/api/admindev/database-safety/status"));
    expect(allowed).not.toBeInstanceOf(NextResponse);
    expect((allowed as typeof context & { service: unknown }).service).toBe(mocks.service);
  });

  it("never permits the development demo context", async () => {
    mocks.requireRole.mockResolvedValue({ ...context, user: null, supabase: null, isDemoMode: true });
    const response = await requireSuperadmin(new Request("https://example.test/api/admindev/database-safety/status"));
    expect((response as NextResponse).status).toBe(401);
  });

  it("enforces exact same-origin CSRF checks", () => {
    expect(assertCriticalSameOrigin(new Request("https://example.test/api/admindev/x", { method: "POST" }))).not.toBeNull();
    expect(assertCriticalSameOrigin(new Request("https://example.test/api/admindev/x", { method: "POST", headers: { origin: "https://evil.test" } }))).not.toBeNull();
    expect(assertCriticalSameOrigin(new Request("https://example.test/api/admindev/x", { method: "POST", headers: { origin: "https://example.test" } }))).toBeNull();
  });
});
