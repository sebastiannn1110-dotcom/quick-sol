import { afterEach, describe, expect, it } from "vitest";
import { getSupabaseServiceRoleKey, isServiceRoleConfigured } from "@/lib/security/env";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("service role environment", () => {
  it("uses SUPABASE_SERVICE_ROLE_KEY first", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
    process.env.SUPABASE_SECRET_KEY = "secret";

    expect(getSupabaseServiceRoleKey()).toBe("service");
    expect(isServiceRoleConfigured()).toBe(true);
  });

  it("falls back to SUPABASE_SECRET_KEY", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SECRET_KEY = "secret";

    expect(getSupabaseServiceRoleKey()).toBe("secret");
    expect(isServiceRoleConfigured()).toBe(true);
  });
});
