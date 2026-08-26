import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { roleSatisfiesAny } from "@/lib/auth/roles";

describe("GET /api/stock-needs role and summary lifecycle", () => {
  const requireRole = vi.fn();
  const buildStockNeedsResult = vi.fn();
  const redactSensitiveFieldsForRole = vi.fn((value) => value);
  const logger = {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    fatal: vi.fn(async () => undefined),
    security: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined)
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ requireRole }));
    vi.doMock("@/lib/stock-needs/stock-needs", () => ({ buildStockNeedsResult }));
    vi.doMock("@/lib/security/permissions", () => ({ redactSensitiveFieldsForRole }));
    vi.doMock("@/lib/logger/logger", () => ({ logger }));
  });

  function authContext(role: "employee" | "manager" | "admin" | "super_admin_dev") {
    return {
      profile: { id: `${role}-id`, role },
      isDemoMode: false,
      supabase: { rpc: vi.fn() }
    };
  }

  function readyState() {
    return {
      summaryReady: true,
      status: "ready",
      currentVersion: 8,
      requiredVersion: 8,
      retryAfter: null,
      pendingCount: 0,
      totalScopes: 2
    };
  }

  it.each(["employee", "manager", "admin", "super_admin_dev"] as const)(
    "serves the optimized summary to %s with pre-read and post-read fences",
    async (role) => {
      const context = authContext(role);
      const fastResult = {
        summaryReady: true,
        items: [{ mpn: "SYNTHETIC-ONLY" }],
        totals: { totalItems: 1 },
        meta: { returnedItems: 1 }
      };
      context.supabase.rpc
        .mockResolvedValueOnce({ data: readyState(), error: null })
        .mockResolvedValueOnce({ data: fastResult, error: null })
        .mockResolvedValueOnce({ data: readyState(), error: null });
      requireRole.mockResolvedValue(context);

      const request = new Request("https://app.test/api/stock-needs?limit=100&offset=25");
      const { GET } = await import("../route");
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager", "employee"]);
      expect(roleSatisfiesAny(role, ["admin", "manager", "employee"])).toBe(true);
      expect(context.supabase.rpc).toHaveBeenNthCalledWith(1, "get_stock_needs_snapshot_state_v1", {
        p_upload_batch_id: null
      });
      expect(context.supabase.rpc).toHaveBeenNthCalledWith(2, "get_stock_needs_snapshot_page_v1", expect.objectContaining({
        p_limit: 100,
        p_offset: 25
      }));
      expect(context.supabase.rpc).toHaveBeenNthCalledWith(3, "get_stock_needs_snapshot_state_v1", {
        p_upload_batch_id: null
      });
      expect(context.supabase.rpc).toHaveBeenCalledTimes(3);
      expect(redactSensitiveFieldsForRole).toHaveBeenCalledWith(fastResult, role);
      expect(await response.json()).toEqual(fastResult);
    }
  );

  it.each(["dirty", "queued", "rebuilding", "retrying", "stale"] as const)(
    "returns bounded HTTP 409 for %s without calling the data RPC or returning false totals",
    async (status) => {
      const context = authContext("manager");
      context.supabase.rpc.mockResolvedValue({
        data: {
          summaryReady: false,
          status,
          currentVersion: 7,
          requiredVersion: 8,
          retryAfter: null,
          pendingCount: 1,
          totalScopes: 2
        },
        error: null
      });
      requireRole.mockResolvedValue(context);

      const { GET } = await import("../route");
      const response = await GET(new Request("https://app.test/api/stock-needs?coverageStatus=no_stock"));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(payload).toMatchObject({
        errorCode: "SUMMARY_NOT_READY",
        summaryStatus: status,
        currentVersion: 7,
        requiredVersion: 8
      });
      expect(payload).not.toHaveProperty("items");
      expect(payload).not.toHaveProperty("totals");
      expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
    }
  );

  it("maps a READY to DIRTY race to HTTP 409 even when the page RPC also errors", async () => {
    const context = authContext("manager");
    context.supabase.rpc
      .mockResolvedValueOnce({ data: readyState(), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "57014" } })
      .mockResolvedValueOnce({
        data: {
          summaryReady: false,
          status: "dirty",
          currentVersion: 8,
          requiredVersion: 9,
          pendingCount: 1,
          totalScopes: 2
        },
        error: null
      });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      errorCode: "SUMMARY_NOT_READY",
      summaryStatus: "dirty",
      currentVersion: 8,
      requiredVersion: 9
    });
    expect(payload).not.toHaveProperty("items");
    expect(payload).not.toHaveProperty("totals");
    expect(context.supabase.rpc).toHaveBeenCalledTimes(3);
  });

  it.each(["queued", "rebuilding", "stale"] as const)(
    "maps a READY to %s post-read transition to HTTP 409",
    async (status) => {
      const context = authContext("manager");
      context.supabase.rpc
        .mockResolvedValueOnce({ data: readyState(), error: null })
        .mockResolvedValueOnce({
          data: { summaryReady: true, items: [{ mpn: "FENCED" }], totals: { totalItems: 1 } },
          error: null
        })
        .mockResolvedValueOnce({
          data: {
            summaryReady: false,
            status,
            currentVersion: 8,
            requiredVersion: 9
          },
          error: null
        });
      requireRole.mockResolvedValue(context);

      const { GET } = await import("../route");
      const response = await GET(new Request("https://app.test/api/stock-needs"));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({ errorCode: "SUMMARY_NOT_READY", summaryStatus: status });
      expect(payload).not.toHaveProperty("items");
      expect(payload).not.toHaveProperty("totals");
    }
  );

  it("returns HTTP 409 when a still-ready summary changes version across the data read", async () => {
    const context = authContext("admin");
    const page = { summaryReady: true, items: [{ mpn: "OLD" }], totals: { totalItems: 1 } };
    context.supabase.rpc
      .mockResolvedValueOnce({ data: { ...readyState(), currentVersion: 8, requiredVersion: 8 }, error: null })
      .mockResolvedValueOnce({ data: page, error: null })
      .mockResolvedValueOnce({ data: { ...readyState(), currentVersion: 9, requiredVersion: 9 }, error: null });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_NOT_READY",
      summaryStatus: "stale",
      currentVersion: 9,
      requiredVersion: 9
    });
  });

  it("keeps an unexpected data RPC failure as HTTP 500 when both fences stay READY", async () => {
    const context = authContext("admin");
    context.supabase.rpc
      .mockResolvedValueOnce({ data: readyState(), error: null })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "57014",
          message: "customer@example.com 018f47d2-a62d-4a71-854b-9a4f22301fc8 PART-SECRET",
          details: "sensitive-file.xlsx token=secret-value must not be logged",
          hint: "service_role signed-url must not be logged"
        }
      })
      .mockResolvedValueOnce({ data: readyState(), error: null });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs", {
      headers: {
        "x-quiksol-trace-id": "trace-r72-safe",
        "x-quiksol-request-id": "request-r72-safe"
      }
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unable to load stock and needs." });
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "stock_needs_rpc_failed",
      message: "SUMMARY_DATA_READ_FAILED",
      statusCode: 500,
      traceId: "trace-r72-safe",
      requestId: "request-r72-safe",
      metadata: expect.objectContaining({
        internalCode: "STOCK_NEEDS_RPC_FAILED",
        dbCode: "57014",
        errorCategory: "STATEMENT_TIMEOUT",
        errorClass: "PostgrestError",
        detailsPresent: true,
        hintPresent: true,
        rpcName: "get_stock_needs_snapshot_page_v1",
        stage: "data_rpc",
        preStatus: "ready",
        postStatus: "ready",
        currentVersion: 8,
        requiredVersion: 8,
        rpcDurationMs: expect.any(Number),
        totalDurationMs: expect.any(Number),
        expectedHttp: 500,
        retryable: true
      })
    }));
    const logged = JSON.stringify(logger.error.mock.calls.at(-1)?.[0]);
    for (const secret of [
      "customer@example.com",
      "018f47d2-a62d-4a71-854b-9a4f22301fc8",
      "PART-SECRET",
      "sensitive-file.xlsx",
      "secret-value",
      "service_role",
      "signed-url"
    ]) expect(logged).not.toContain(secret);
  });

  it.each([
    ["40001", "SERIALIZATION_FAILURE", true],
    ["40P01", "DEADLOCK", true],
    ["42501", "PERMISSION_FAILURE", false],
    ["PGRST500", "POSTGREST_FAILURE", false]
  ] as const)("logs injected RPC code %s as %s and keeps HTTP 500", async (code, category, retryable) => {
    const context = authContext("admin");
    context.supabase.rpc
      .mockResolvedValueOnce({ data: readyState(), error: null })
      .mockResolvedValueOnce({ data: null, error: { code, message: "private-value" } })
      .mockResolvedValueOnce({ data: readyState(), error: null });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "stock_needs_rpc_failed",
      metadata: expect.objectContaining({
        internalCode: "STOCK_NEEDS_RPC_FAILED",
        dbCode: code,
        errorCategory: category,
        retryable
      })
    }));
    expect(JSON.stringify(logger.error.mock.calls.at(-1)?.[0])).not.toContain("private-value");
  });

  it("separates an interrupted transport from a PostgREST response", async () => {
    const context = authContext("admin");
    const interruption = Object.assign(new Error("connection secret must not be logged"), { code: "08006" });
    context.supabase.rpc
      .mockResolvedValueOnce({ data: readyState(), error: null })
      .mockRejectedValueOnce(interruption)
      .mockResolvedValueOnce({ data: readyState(), error: null });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "stock_needs_transport_failed",
      metadata: expect.objectContaining({
        internalCode: "STOCK_NEEDS_TRANSPORT_FAILED",
        dbCode: "08006",
        errorCategory: "CONNECTION_FAILURE",
        errorClass: "TransportError",
        retryable: true
      })
    }));
    expect(JSON.stringify(logger.error.mock.calls.at(-1)?.[0])).not.toContain("connection secret");
  });

  it("separates an invalid RPC payload from a database failure", async () => {
    const context = authContext("admin");
    context.supabase.rpc
      .mockResolvedValueOnce({ data: readyState(), error: null })
      .mockResolvedValueOnce({ data: { items: [], totals: {}, meta: {} }, error: null })
      .mockResolvedValueOnce({ data: readyState(), error: null });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs?limit=100"));

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "stock_needs_data_shape_invalid",
      message: "SUMMARY_DATA_SHAPE_INVALID",
      metadata: expect.objectContaining({
        internalCode: "STOCK_NEEDS_DATA_SHAPE_INVALID",
        dbCode: null,
        errorCategory: "DATA_SHAPE_FAILURE",
        errorClass: "DataShapeError",
        stage: "data_shape",
        preStatus: "ready",
        postStatus: "ready"
      })
    }));
  });

  it("serves 1,000 consecutive stable READY reads with the same logical result", async () => {
    const context = authContext("manager");
    const stablePage = {
      summaryReady: true,
      items: [{ mpn: "STABLE-100" }],
      totals: { totalItems: 1 },
      meta: { limit: 100, offset: 0, returnedItems: 1 }
    };
    context.supabase.rpc.mockImplementation(async (rpcName: string) => (
      rpcName === "get_stock_needs_snapshot_page_v1"
        ? { data: stablePage, error: null }
        : { data: readyState(), error: null }
    ));
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const response = await GET(new Request("https://app.test/api/stock-needs?limit=100"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(stablePage);
    }

    expect(context.supabase.rpc).toHaveBeenCalledTimes(1_000 * 3);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("serves 20 clients with 50 stable READY reads each without cross-request failures", async () => {
    const context = authContext("manager");
    const stablePage = {
      summaryReady: true,
      items: [{ mpn: "CONCURRENT-100" }],
      totals: { totalItems: 1 },
      meta: { limit: 100, offset: 0, returnedItems: 1 }
    };
    context.supabase.rpc.mockImplementation(async (rpcName: string) => (
      rpcName === "get_stock_needs_snapshot_page_v1"
        ? { data: stablePage, error: null }
        : { data: readyState(), error: null }
    ));
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const clients = Array.from({ length: 20 }, (_, clientIndex) => clientIndex);
    const results = await Promise.all(clients.map(async (clientIndex) => {
      const statuses: number[] = [];
      for (let requestIndex = 0; requestIndex < 50; requestIndex += 1) {
        const response = await GET(new Request(
          `https://app.test/api/stock-needs?limit=100&client=${clientIndex}`
        ));
        statuses.push(response.status);
        expect(await response.json()).toEqual(stablePage);
      }
      return statuses;
    }));

    expect(results.flat()).toHaveLength(1_000);
    expect(results.flat().every((status) => status === 200)).toBe(true);
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1_000 * 3);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("returns HTTP 503 for a failed rebuild without querying page data", async () => {
    const context = authContext("admin");
    context.supabase.rpc.mockResolvedValue({
      data: { summaryReady: false, status: "failed", currentVersion: 7, requiredVersion: 8 },
      error: null
    });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_REBUILD_FAILED",
      summaryStatus: "failed"
    });
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it.each(["PGRST202", "42883"])("fails closed with HTTP 503 when state contract is unavailable (%s)", async (code) => {
    const context = authContext("employee");
    context.supabase.rpc.mockResolvedValue({ data: null, error: { code } });
    requireRole.mockResolvedValue(context);

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/stock-needs"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorCode: "SUMMARY_CONTRACT_UNAVAILABLE",
      summaryStatus: "contract_unavailable"
    });
    expect(context.supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves the role guard response", async () => {
    const denied = NextResponse.json({ error: "denied" }, { status: 403 });
    requireRole.mockResolvedValue(denied);

    const request = new Request("https://app.test/api/stock-needs");
    const { GET } = await import("../route");
    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(request, ["admin", "manager", "employee"]);
  });
});
