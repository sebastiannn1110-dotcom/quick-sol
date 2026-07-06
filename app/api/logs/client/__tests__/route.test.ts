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

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAuthContext.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  it("accepts sanitized public logs from password reset pages without returning 401", async () => {
    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/logs/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  });
});
