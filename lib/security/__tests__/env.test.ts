import { afterEach, describe, expect, it } from "vitest";
import { getRowsPerFileLimit, getSupabaseServiceRoleKey, isServiceRoleConfigured } from "@/lib/security/env";

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

describe("row limit environment", () => {
  it("uses MAX_ROWS_PER_FILE before MAX_EXCEL_ROWS", () => {
    process.env.MAX_ROWS_PER_FILE = "500000";
    process.env.MAX_EXCEL_ROWS = "100000";

    expect(getRowsPerFileLimit()).toBe(500000);
  });

  it("does not trust a dangerous legacy MAX_EXCEL_ROWS when MAX_ROWS_PER_FILE is missing", () => {
    delete process.env.MAX_ROWS_PER_FILE;
    process.env.MAX_EXCEL_ROWS = "200000000";

    expect(getRowsPerFileLimit()).toBe(100000);
  });
});
