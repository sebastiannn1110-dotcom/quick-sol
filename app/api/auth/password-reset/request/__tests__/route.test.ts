import { beforeEach, describe, expect, it, vi } from "vitest";

function createLoggerMock() {
  return {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    fatal: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined)
  };
}

function createMissingPasswordResetTableService() {
  const missingError = {
    code: "PGRST205",
    message: "Could not find the table 'public.password_reset_codes' in the schema cache"
  };
  const builder = {
    select: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    is: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: null, error: missingError }))
  };
  return { from: vi.fn(() => builder) };
}

describe("POST /api/auth/password-reset/request", () => {
  const logger = createLoggerMock();
  const checkPersistentRateLimit = vi.fn();
  const createSupabaseServiceRoleClient = vi.fn();
  const sendEmail = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    checkPersistentRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 1,
      resetAt: Date.now() + 60_000,
      persistent: false
    });
    sendEmail.mockResolvedValue({ provider: "mock", status: "skipped" });
    createSupabaseServiceRoleClient.mockReturnValue(createMissingPasswordResetTableService());

    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/security/persistent-rate-limit", () => ({ checkPersistentRateLimit }));
    vi.doMock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient }));
    vi.doMock("@/lib/email/email-service", () => ({ sendEmail }));
  });

  it("returns validation JSON for invalid email", async () => {
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" })
    }));

    await expect(response.json()).resolves.toEqual({ error: "Escribe un correo valido." });
    expect(response.status).toBe(400);
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns a migration error when password reset tables are missing", async () => {
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" })
    }));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error).toContain("recuperacion de contrasena");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "password_reset_schema_missing",
      metadata: expect.objectContaining({ requiredMigration: "20260629000000_enterprise_mvp.sql" })
    }));
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
