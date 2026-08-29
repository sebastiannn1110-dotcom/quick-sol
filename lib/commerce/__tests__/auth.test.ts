import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  profileSingle: vi.fn(),
  adminSignOut: vi.fn()
}));

const profileBuilder = {
  select: vi.fn(() => profileBuilder),
  eq: vi.fn(() => profileBuilder),
  maybeSingle: mocks.profileSingle
};
const client = {
  auth: { getUser: mocks.getUser },
  from: vi.fn(() => profileBuilder)
};

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/security/env", () => ({
  isSupabaseConfigured: () => true,
  getSupabasePublishableKey: () => "sb_publishable_test"
}));
vi.mock("@/lib/supabase/node-client-options", () => ({
  serverSupabaseClientOptions: () => ({ auth: { autoRefreshToken: false, persistSession: false } })
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({ auth: { admin: { signOut: mocks.adminSignOut } } })
}));

import {
  authenticateCommerceToken,
  commerceSessionPayload,
  revokeCommerceSession
} from "@/lib/commerce/auth";

function profile(isActive = true) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    full_name: "Maya Torres",
    email: "maya@quiksol.demo.invalid",
    role: "employee",
    department: "Sales",
    region: "Americas",
    is_active: isActive,
    created_at: "2026-08-29T00:00:00.000Z",
    updated_at: "2026-08-29T00:00:00.000Z"
  };
}

describe("commerce Supabase Bearer authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.invalid";
    mocks.createClient.mockReturnValue(client);
    mocks.getUser.mockResolvedValue({
      data: { user: { id: profile().id, email: profile().email } },
      error: null
    });
    mocks.profileSingle.mockResolvedValue({ data: profile(), error: null });
    mocks.adminSignOut.mockResolvedValue({ data: null, error: null });
  });

  it("accepts a valid token only after loading an active current profile", async () => {
    const result = await authenticateCommerceToken("valid-access-token");
    expect(result).not.toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) throw new Error("unexpected response");
    expect(result.profile.full_name).toBe("Maya Torres");
    expect(mocks.getUser).toHaveBeenCalledWith("valid-access-token");
    expect(profileBuilder.eq).toHaveBeenCalledWith("id", profile().id);
  });

  it("rejects an expired or invalid access token with 401", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "expired" } });
    const result = await authenticateCommerceToken("expired-access-token");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("rejects an inactive employee even when the Auth token is valid", async () => {
    mocks.profileSingle.mockResolvedValue({ data: profile(false), error: null });
    const result = await authenticateCommerceToken("valid-access-token");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    await expect((result as NextResponse).json()).resolves.toMatchObject({ error: { code: "PROFILE_INACTIVE" } });
  });

  it("returns web-compatible session data without hiding technical scopes", async () => {
    const payload = commerceSessionPayload({
      user: { id: profile().id, email: profile().email } as never,
      profile: { ...profile(), role: "super_admin_dev" }
    });
    expect(payload.role).toBe("admin");
    expect(payload.technicalRole).toBe("super_admin_dev");
    expect(payload.scopes.allOperations).toBe(true);
  });

  it("revokes the Supabase session server-side without returning a service key", async () => {
    await revokeCommerceSession("valid-access-token");
    expect(mocks.adminSignOut).toHaveBeenCalledWith("valid-access-token", "local");
  });
});
