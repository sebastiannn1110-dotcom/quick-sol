import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
  security: vi.fn(async () => undefined),
  debug: vi.fn(async () => undefined),
  audit: vi.fn(async () => undefined)
}));

const profileBuilder = {
  select: vi.fn(() => profileBuilder),
  eq: vi.fn(() => profileBuilder),
  single: mocks.profileSingle
};
const supabase = {
  auth: { getUser: mocks.getUser },
  from: vi.fn(() => profileBuilder)
};

vi.mock("@/lib/security/env", () => ({
  isDemoModeAllowed: () => false,
  isSupabaseConfigured: () => true
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => supabase),
  createSupabaseServiceRoleClient: vi.fn(() => null)
}));
vi.mock("@/lib/logger/context", () => ({
  getLoggerContextFromRequest: () => ({ traceId: "trace", requestId: "request" })
}));
vi.mock("@/lib/security/rateLimit", () => ({ requestIp: () => "127.0.0.1" }));
vi.mock("@/lib/logger/logger", () => ({ logger: mocks }));

import { getAuthContext, requireAdmin, requireRole } from "@/lib/auth/context";

function activeProfile(role: UserRole, isActive = true) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    full_name: "Synthetic Session User",
    email: "session@example.test",
    role,
    department: null,
    region: null,
    is_active: isActive,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  };
}

describe("auth context session and role regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "00000000-0000-4000-8000-000000000001", email: "session@example.test" } },
      error: null
    });
    mocks.profileSingle.mockResolvedValue({ data: activeProfile("employee"), error: null });
  });

  it("returns 401 for a missing or expired session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    const result = await getAuthContext(new Request("https://app.test/api/me"));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 403 for an inactive profile", async () => {
    mocks.profileSingle.mockResolvedValue({ data: activeProfile("employee", false), error: null });
    const result = await getAuthContext(new Request("https://app.test/api/me"));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("lets Super Admin Dev inherit requireAdmin", async () => {
    mocks.profileSingle.mockResolvedValue({ data: activeProfile("super_admin_dev"), error: null });
    const result = await requireAdmin(new Request("https://app.test/api/admin/users"));

    expect(result).not.toBeInstanceOf(NextResponse);
  });

  it("does not let admin inherit a Super Admin Dev-only role guard", async () => {
    mocks.profileSingle.mockResolvedValue({ data: activeProfile("admin"), error: null });
    const result = await requireRole(
      new Request("https://app.test/api/superadmin/health"),
      ["super_admin_dev"]
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });
});
