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

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  full_name: "Quiksol Admin",
  email: "admin@quiksol.local",
  role: "admin",
  department: "Operations",
  region: "Global",
  is_active: true,
  created_at: "2026-06-25T00:00:00.000Z",
  updated_at: "2026-06-25T00:00:00.000Z"
};

describe("POST /api/upload", () => {
  const logger = createLoggerMock();
  const getAuthContext = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
    getAuthContext.mockResolvedValue({
      user: null,
      profile,
      supabase: null,
      isDemoMode: false,
      requestMeta: {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        route: "/api/upload",
        traceId: "trace-id",
        requestId: "request-id"
      }
    });
  });

  it("rejects the legacy POST flow without reading multipart file bodies", async () => {
    const { POST } = await import("../route");
    const request = new Request("https://app.test/api/upload", { method: "POST" });
    const formData = vi.fn(async () => {
      throw new Error("formData should not be read by the legacy endpoint.");
    });
    Object.defineProperty(request, "formData", { value: formData });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.message).toContain("/api/upload/initiate");
    expect(formData).not.toHaveBeenCalled();
  });
});
