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

function createPasswordResetService(profile: { id: string; email: string; full_name: string; is_active: boolean } | null) {
  const insert = vi.fn();
  const tables: string[] = [];
  const codeBuilder = {
    error: null,
    select: vi.fn(() => codeBuilder),
    ilike: vi.fn(() => codeBuilder),
    gte: vi.fn(() => codeBuilder),
    is: vi.fn(() => codeBuilder),
    limit: vi.fn(() => codeBuilder),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    update: vi.fn(() => codeBuilder),
    eq: vi.fn(() => codeBuilder),
    insert: vi.fn((payload) => {
      insert(payload);
      return codeBuilder;
    }),
    single: vi.fn(async () => ({ data: { id: "reset-row-1" }, error: null }))
  };
  const profileBuilder = {
    select: vi.fn(() => profileBuilder),
    ilike: vi.fn(() => profileBuilder),
    eq: vi.fn(() => profileBuilder),
    limit: vi.fn(() => profileBuilder),
    maybeSingle: vi.fn(async () => ({ data: profile, error: null }))
  };

  return {
    insert,
    from: vi.fn((table: string) => {
      tables.push(table);
      return table === "profiles" ? profileBuilder : codeBuilder;
    }),
    tables
  };
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
    process.env.PASSWORD_RESET_SECRET = "unit-test-password-reset-secret";

    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/security/persistent-rate-limit", () => ({ checkPersistentRateLimit }));
    vi.doMock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient }));
    vi.doMock("@/lib/email/email-service", () => ({
      sendEmail,
      getEmailProviderDiagnostics: vi.fn(() => ({
        provider: "mock",
        hasResendApiKey: false,
        hasSmtpConfig: false,
        emailFrom: "Quiksol Alerts <alerts@quiksol.local>",
        canSendRealEmail: false,
        warnings: ["Email provider is mock; no real email was sent."]
      }))
    }));
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

  it("creates a reset code and calls email service for an existing user", async () => {
    const service = createPasswordResetService({
      id: "00000000-0000-4000-8000-000000000001",
      email: "user@example.com",
      full_name: "User",
      is_active: true
    });
    createSupabaseServiceRoleClient.mockReturnValue(service);
    sendEmail.mockResolvedValue({ provider: "resend", status: "sent", messageId: "email-1" });

    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" })
    }));

    await expect(response.json()).resolves.toEqual({
      message: "Si el correo esta registrado, enviaremos un codigo de recuperacion.",
      cooldownSeconds: expect.any(Number)
    });
    expect(response.status).toBe(202);
    expect(service.insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "00000000-0000-4000-8000-000000000001",
      email: "user@example.com"
    }));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ["user@example.com"],
      subject: "[Quiksol] Codigo de recuperacion de contrasena"
    }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ action: "password_reset_code_created" }));
  });

  it("returns a generic response and does not create a code for an unknown user", async () => {
    const service = createPasswordResetService(null);
    createSupabaseServiceRoleClient.mockReturnValue(service);

    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "missing@example.com" })
    }));

    expect(response.status).toBe(202);
    expect(service.insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ action: "password_reset_user_not_found" }));
  });

  it("logs when the email provider does not send a real message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = createPasswordResetService({
      id: "00000000-0000-4000-8000-000000000001",
      email: "user@example.com",
      full_name: "User",
      is_active: true
    });
    createSupabaseServiceRoleClient.mockReturnValue(service);
    sendEmail.mockResolvedValue({ provider: "mock", status: "skipped", errorMessage: "Email provider is mock; no real email was sent." });

    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com" })
    }));

    expect(response.status).toBe(202);
    expect(consoleError).toHaveBeenCalledWith("password_reset_email_failed", expect.objectContaining({
      provider: "mock",
      status: "skipped",
      errorMessage: "Email provider is mock; no real email was sent."
    }));
    consoleError.mockRestore();
  });
});
