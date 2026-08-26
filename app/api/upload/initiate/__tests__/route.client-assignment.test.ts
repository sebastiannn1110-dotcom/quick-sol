import { beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /api/upload/initiate client authorization", () => {
  const getAuthContext = vi.fn();
  const logUploadDiagnostic = vi.fn(async () => undefined);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(async () => undefined),
    fatal: vi.fn(),
    security: vi.fn(),
    audit: vi.fn()
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext,
      logAuditEvent: vi.fn(async () => undefined)
    }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
    vi.doMock("@/lib/upload/diagnostics", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/upload/diagnostics")>();
      return { ...actual, logUploadDiagnostic };
    });
  });

  function body(clientId = "20000000-0000-4000-8000-000000000001") {
    return {
      clientId,
      fileName: "stock.xlsx",
      fileSize: 1024,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      selectedCategory: "Auto Detect",
      department: "Sales",
      region: "Global",
      notes: "",
      idempotencyKey: "stock.xlsx:1024:1"
    };
  }

  function context(role: "employee" | "manager", supabase: unknown) {
    return {
      profile: { id: "10000000-0000-4000-8000-000000000001", email: "actor@example.test", role },
      supabase,
      isDemoMode: false,
      requestMeta: {
        traceId: "trace",
        requestId: "request",
        route: "/api/upload/initiate",
        method: "POST"
      }
    };
  }

  it("returns 403 before creating an upload when the role cannot assign companies", async () => {
    const from = vi.fn();
    getAuthContext.mockResolvedValue(context("employee", { from }));

    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/upload/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body())
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PERMISSION_ERROR" });
    expect(from).not.toHaveBeenCalled();
  });

  it("returns 404 when RLS does not expose the requested company", async () => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "maybeSingle"]) query[method] = vi.fn(() => query);
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);
    const from = vi.fn(() => query);
    getAuthContext.mockResolvedValue(context("manager", { from }));

    const { POST } = await import("../route");
    const response = await POST(new Request("https://app.test/api/upload/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body())
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_CLIENT_NOT_FOUND" });
    expect(from).toHaveBeenCalledWith("clients");
  });
});
