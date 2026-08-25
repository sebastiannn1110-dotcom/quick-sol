import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

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

describe("POST /api/logs/client", () => {
  const logger = createLoggerMock();
  const getAuthContext = vi.fn();
  const checkPersistentRateLimit = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    getAuthContext.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    checkPersistentRateLimit.mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000, persistent: true });
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    vi.doMock("@/lib/security/persistent-rate-limit", () => ({ checkPersistentRateLimit }));
  });

  it("accepts sanitized public logs from password reset pages without returning 401", async () => {
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({
        level: "info",
        action: "page_view",
        message: "Page viewed",
        route: "/reset-password",
        metadata: { source: "test" }
      })
    }));

    expect(response.status).toBe(204);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      route: "/reset-password",
      action: "page_view",
      metadata: expect.objectContaining({ publicLog: true })
    }));
    expect(checkPersistentRateLimit).toHaveBeenCalledWith(expect.objectContaining({ action: "public_client_log", limit: 30, alwaysEnforce: true }));
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it("rate limits public log flooding before writing an event", async () => {
    checkPersistentRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000, persistent: true });
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test", "x-forwarded-for": "192.0.2.10" },
      body: JSON.stringify({ level: "info", action: "page_view", message: "Page viewed", route: "/login" })
    }));

    expect(response.status).toBe(429);
    expect(logger.info).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("fails closed in production when the persistent limiter is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    checkPersistentRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: Date.now() + 60_000, persistent: false });
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({ level: "info", action: "page_view", message: "Page viewed", route: "/login" })
    }));

    expect(response.status).toBe(503);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("rejects oversized and sensitive public payloads", async () => {
    const { POST } = await import("../route");
    const oversized = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({ level: "info", action: "page_view", message: "x".repeat(5000), route: "/login" })
    }));
    expect(oversized.status).toBe(413);

    const sensitive = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({ level: "error", action: "page_view", message: "Bearer secret-value", route: "/login" })
    }));
    expect(sensitive.status).toBe(422);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rejects control characters in public log fields", async () => {
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify({ level: "warn", action: "page_view", message: "Page\u0000viewed", route: "/login" })
    }));

    expect(response.status).toBe(422);
    expect(checkPersistentRateLimit).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts authenticated logging behind a trusted reverse proxy", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const from = vi.fn(() => ({ insert }));
    getAuthContext.mockResolvedValueOnce({
      user: { id: "00000000-0000-4000-8000-000000000010" },
      profile: {
        id: "00000000-0000-4000-8000-000000000010",
        email: "redacted@example.test",
        role: "super_admin_dev",
        is_active: true
      },
      supabase: { from },
      isDemoMode: false,
      requestMeta: {
        traceId: "00000000-0000-4000-8000-000000000011",
        requestId: "00000000-0000-4000-8000-000000000012",
        route: "/api/logs/client",
        ipAddress: "192.0.2.20",
        userAgent: "test"
      }
    });
    const { POST } = await import("../route");
    const response = await POST(new Request("http://10.0.0.5:10000/api/logs/client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://quick-sol.onrender.com",
        "x-forwarded-host": "quick-sol.onrender.com",
        "x-forwarded-proto": "https"
      },
      body: JSON.stringify({
        level: "info",
        action: "page_view",
        message: "Page viewed",
        route: "/records",
        metadata: { source: "test" }
      })
    }));

    expect(response.status).toBe(200);
    expect(getAuthContext).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("client_logs");
    expect(insert).toHaveBeenCalledOnce();
  });

  it("continues rejecting missing and mismatched origins before authentication", async () => {
    const { POST } = await import("../route");
    const payload = JSON.stringify({ level: "info", action: "page_view", message: "Page viewed", route: "/records" });
    const missing = await POST(new Request("https://quick-sol.onrender.com/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    }));
    const mismatched = await POST(new Request("http://10.0.0.5:10000/api/logs/client", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        "x-forwarded-host": "quick-sol.onrender.com",
        "x-forwarded-proto": "https"
      },
      body: payload
    }));

    expect(missing.status).toBe(403);
    expect(mismatched.status).toBe(403);
    expect(getAuthContext).not.toHaveBeenCalled();
  });
});
