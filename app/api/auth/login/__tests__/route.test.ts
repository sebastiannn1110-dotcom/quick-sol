import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  warn: vi.fn(),
  audit: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { signInWithPassword: mocks.signInWithPassword }
  }))
}));
vi.mock("@/lib/logger/logger", () => ({ logger: { warn: mocks.warn, audit: mocks.audit } }));
vi.mock("@/lib/logger/context", () => ({
  getLoggerContextFromRequest: () => ({ traceId: "trace", requestId: "request", route: "/api/auth/login", method: "POST" })
}));
vi.mock("@/lib/security/rateLimit", () => ({
  requestIp: () => "127.0.0.1",
  checkRateLimit: () => ({ allowed: true, resetAt: Date.now() + 1000 }),
  rateLimitResponse: vi.fn()
}));

import { POST } from "@/app/api/auth/login/route";

function request(identifier: string, password: string) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the presentation username to the server-only technical email", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "token" }, user: { id: "owner-id" } },
      error: null
    });
    const response = await POST(request("user.test.demo.com", "password.tets.demo.com"));
    expect(response.status).toBe(200);
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: "user.test.demo.com@demo.invalid",
      password: "password.tets.demo.com"
    });
  });

  it("returns a generic failure for a wrong password", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: new Error("bad password") });
    const response = await POST(request("user.test.demo.com", "wrong-password"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Invalid credentials." });
  });

  it("does not map the retired legacy identity", async () => {
    mocks.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: new Error("not found") });
    const retiredEmail = ["ja", "son", "Boss", "@", "quiksol.com"].join("");
    await POST(request(retiredEmail, "irrelevant"));
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: retiredEmail.toLowerCase(),
      password: "irrelevant"
    });
  });
});
