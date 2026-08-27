import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/auth/public-config/route";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/auth/public-config", () => {
  it("returns only the public values required by the existing login", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.example.test";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_runtime_test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "server-service-role-secret";
    process.env.SUPABASE_SECRET_KEY = "server-secret-key";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      configured: true,
      supabaseUrl: "https://project.example.test",
      supabasePublishableKey: "sb_publishable_runtime_test"
    });
    expect(Object.keys(body).sort()).toEqual([
      "configured",
      "supabasePublishableKey",
      "supabaseUrl"
    ]);
    expect(JSON.stringify(body)).not.toContain("server-service-role-secret");
    expect(JSON.stringify(body)).not.toContain("server-secret-key");
  });

  it("does not fall back to server credentials when public login config is absent", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "server-service-role-secret";
    process.env.SUPABASE_SECRET_KEY = "server-secret-key";

    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      configured: false,
      supabaseUrl: "",
      supabasePublishableKey: ""
    });
  });
});
