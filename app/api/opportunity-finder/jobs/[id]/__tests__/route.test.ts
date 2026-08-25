import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";

const JOB_ID = "00000000-0000-4000-8000-000000000003";
const TENANT_ID = "00000000-0000-4000-8000-000000000010";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

type ConfigureOptions = {
  idempotencyKey: string | null;
  filterOverrides?: Record<string, unknown>;
  role?: "employee" | "manager" | "admin";
  tenantAdmin?: boolean;
  results?: Record<string, unknown>[];
  possibleMatches?: Record<string, unknown>[];
  possibleCount?: number;
  rejectedRows?: Record<string, unknown>[];
  rejectedCount?: number;
  commercialRows?: Record<string, unknown>[];
  financialRows?: Record<string, unknown>[];
  hydratedResults?: Record<string, unknown>[];
};

function pagedQuery(data: Record<string, unknown>[], count = data.length) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["eq", "ilike", "or", "gt", "order"]) {
    query[method] = vi.fn(() => query);
  }
  query.range = vi.fn(async () => ({ data, error: null, count }));
  return query;
}

function createSupabaseMock(options: ConfigureOptions) {
  const filesTable = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        order: vi.fn(async () => ({ data: [], error: null }))
      }))
    }))
  };
  const resultsQuery = pagedQuery(options.results ?? []);
  const possibleQuery = pagedQuery(
    options.possibleMatches ?? [],
    options.possibleCount ?? options.possibleMatches?.length ?? 0
  );
  const rejectedQuery = pagedQuery(
    options.rejectedRows ?? [],
    options.rejectedCount ?? options.rejectedRows?.length ?? 0
  );
  const resultsTable = { select: vi.fn(() => resultsQuery) };
  const possibleTable = { select: vi.fn(() => possibleQuery) };
  const rejectedTable = { select: vi.fn(() => rejectedQuery) };
  const rpc = vi.fn(async (name: string) => {
    if (name === "is_opportunity_finder_tenant_admin") {
      return { data: options.tenantAdmin ?? false, error: null };
    }
    return { data: null, error: null };
  });
  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === "opportunity_finder_files") return filesTable;
        if (table === "opportunity_finder_results") return resultsTable;
        if (table === "opportunity_finder_possible_matches") return possibleTable;
        if (table === "opportunity_finder_rejected_rows") return rejectedTable;
        throw new Error(`Unexpected table ${table}`);
      }),
      rpc
    },
    resultsQuery,
    possibleQuery,
    rejectedQuery,
    rpc
  };
}

function protectedTable(rows: Record<string, unknown>[]) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.eq = vi.fn(() => query);
  query.in = vi.fn(async () => ({ data: rows, error: null }));
  return { select: vi.fn(() => query), query };
}

async function configureRoute(options: ConfigureOptions) {
  const database = createSupabaseMock(options);
  const commercialTable = protectedTable(options.commercialRows ?? []);
  const financialTable = protectedTable(options.financialRows ?? []);
  const service = {
    from: vi.fn((table: string) => {
      if (table === "opportunity_finder_result_commercials") return commercialTable;
      if (table === "opportunity_finder_result_financials") return financialTable;
      throw new Error(`Unexpected service table ${table}`);
    })
  };
  const resultDatabaseRow = vi.fn((row, _pipelineVersion, protectedFields) => ({
    ...row,
    protectedFields
  }));
  const hydrateUserScopedOpportunityAllocations = vi.fn(async (
    _supabase: unknown,
    _jobId: string,
    rows: Record<string, unknown>[]
  ) => ({ rows: options.hydratedResults ?? rows, error: null }));
  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: {
        id: "00000000-0000-4000-8000-000000000001",
        role: options.role ?? "employee"
      },
      supabase: database.supabase,
      isDemoMode: false
    })),
    logAuditEvent: vi.fn(async () => undefined)
  }));
  vi.doMock("@/lib/stock-needs/stock-needs", () => ({
    normalizePartNumberForMatch: vi.fn(() => "")
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => service)
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn((value: string) => value),
    hydrateUserScopedOpportunityAllocations,
    loadOwnedOpportunityJob: vi.fn(async () => ({
      id: JOB_ID,
      tenant_id: TENANT_ID,
      idempotency_key: options.idempotencyKey,
      status: "completed",
      current_stage: "completed",
      progress_percent: 100,
      summary_json: {},
      created_at: "2026-07-29T12:00:00.000Z"
    })),
    OPPORTUNITY_FILE_SELECT: "id",
    OPPORTUNITY_RESULT_SELECT: "id",
    resultDatabaseRow,
    resultFilters: vi.fn(() => ({
      q: null,
      manufacturer: null,
      context: null,
      opportunityType: null,
      fileId: null,
      withShortage: false,
      withAvailable: false,
      exactOnly: false,
      offset: 0,
      limit: 48,
      ...options.filterOverrides
    }))
  }));
  const route = await import("../route");
  return {
    route,
    database,
    service,
    resultDatabaseRow,
    hydrateUserScopedOpportunityAllocations
  };
}

function request(query = "") {
  return new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}${query}`);
}

function params() {
  return { params: Promise.resolve({ id: JOB_ID }) };
}

async function configureDeleteRoute(options: {
  prepareError?: { code: string } | null;
  removeError?: Record<string, unknown> | null;
} = {}) {
  const operations: string[] = [];
  const files = [
    {
      id: "00000000-0000-4000-8000-000000000020",
      job_id: JOB_ID,
      original_file_name: "demand.xlsx",
      storage_bucket: "opportunity-finder",
      storage_path: `${OWNER_ID}/${JOB_ID}/00000000-0000-4000-8000-000000000020.xlsx`
    },
    {
      id: "00000000-0000-4000-8000-000000000021",
      job_id: JOB_ID,
      original_file_name: "supply.xlsx",
      storage_bucket: "opportunity-finder",
      storage_path: `${OWNER_ID}/${JOB_ID}/00000000-0000-4000-8000-000000000021.xlsx`
    }
  ];
  const fileEq = vi.fn(async () => ({ data: files, error: null }));
  const serviceFrom = vi.fn((table: string) => {
    operations.push(`db:${table}`);
    if (table !== "opportunity_finder_files") {
      throw new Error(`Unexpected mutation of ${table}`);
    }
    return { select: vi.fn(() => ({ eq: fileEq })) };
  });
  const remove = vi.fn(async (paths: string[]) => {
    operations.push(`storage.remove:${paths[0]}`);
    return { error: options.removeError ?? null };
  });
  const storageFrom = vi.fn((bucket: string) => {
    operations.push(`storage.from:${bucket}`);
    return { remove };
  });
  const rpc = vi.fn(async (name: string) => {
    operations.push(`rpc:${name}`);
    if (name === "prepare_opportunity_finder_job_deletion") {
      return options.prepareError
        ? { data: null, error: options.prepareError }
        : { data: { id: JOB_ID, status: "deleting" }, error: null };
    }
    if (name === "finalize_opportunity_finder_job_deletion") {
      return { data: { id: JOB_ID }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const service = {
    from: serviceFrom,
    rpc,
    storage: { from: storageFrom }
  };
  const logAuditEvent = vi.fn(async () => undefined);
  const authSupabase = { from: vi.fn() };

  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: { id: OWNER_ID, role: "employee" },
      supabase: authSupabase,
      isDemoMode: false
    })),
    logAuditEvent
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn((value: string) => value),
    hydrateUserScopedOpportunityAllocations: vi.fn(async (
      _supabase: unknown,
      _jobId: string,
      rows: Record<string, unknown>[]
    ) => ({
      rows,
      error: null
    })),
    loadOwnedOpportunityJob: vi.fn(async () => ({
      id: JOB_ID,
      status: "completed",
      created_by: OWNER_ID
    })),
    OPPORTUNITY_FILE_SELECT: "id",
    OPPORTUNITY_RESULT_SELECT: "id",
    resultDatabaseRow: vi.fn(),
    resultFilters: vi.fn()
  }));
  vi.doMock("@/lib/stock-needs/stock-needs", () => ({
    normalizePartNumberForMatch: vi.fn(() => "")
  }));
  vi.doMock("@/lib/security/permissions", () => ({
    getRolePermissions: vi.fn(() => ({ canViewPricing: false, canViewFinancials: false }))
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => service)
  }));

  const route = await import("../route");
  return { route, operations, rpc, serviceFrom, storageFrom, remove, logAuditEvent };
}

describe("GET /api/opportunity-finder/jobs/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the version encoded in a current idempotency key", async () => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      files: [
        { side: "A", contentSha256: "a".repeat(64) },
        { side: "B", contentSha256: "b".repeat(64) }
      ]
    });
    const { route } = await configureRoute({ idempotencyKey });

    const response = await route.GET(request(), params());
    const payload = await response.json();

    expect(payload.job.pipelineVersion).toBe(OPPORTUNITY_FINDER_PIPELINE_VERSION);
  });

  it("returns null for a legacy unversioned job", async () => {
    const { route } = await configureRoute({ idempotencyKey: "legacy-random-key" });

    const response = await route.GET(request(), params());
    const payload = await response.json();

    expect(payload.job.pipelineVersion).toBeNull();
  });

  it("filters usable availability instead of the original aggregate quantity", async () => {
    const { route, database } = await configureRoute({
      idempotencyKey: "legacy-random-key",
      filterOverrides: { withAvailable: true }
    });

    await route.GET(request(), params());

    expect(database.resultsQuery.eq).toHaveBeenCalledWith("usable_availability_match", true);
    expect(database.resultsQuery.eq).not.toHaveBeenCalledWith("available_qty", 0);
  });

  it("returns protected pricing only when the app role and tenant-admin RPC both allow it", async () => {
    const resultId = "00000000-0000-4000-8000-000000000020";
    const commercial = {
      result_id: resultId,
      target_price: 2.5,
      offer_price: 2,
      pricing_quality: "confirmed"
    };
    const financial = {
      result_id: resultId,
      unit_cost: 1.5,
      gross_profit: 50,
      gross_margin_percent: 25,
      cost_quality: "valid"
    };
    const allowed = await configureRoute({
      idempotencyKey: "legacy-random-key",
      role: "admin",
      tenantAdmin: true,
      results: [{ id: resultId }],
      commercialRows: [commercial],
      financialRows: [financial]
    });

    const response = await allowed.route.GET(request(), params());
    const payload = await response.json();

    expect(allowed.database.rpc).toHaveBeenCalledWith(
      "is_opportunity_finder_tenant_admin",
      { target_tenant_id: TENANT_ID }
    );
    expect(allowed.service.from).toHaveBeenCalledTimes(2);
    expect(allowed.resultDatabaseRow).toHaveBeenCalledWith(
      { id: resultId },
      null,
      { commercial, financial }
    );
    expect(payload.capabilities).toEqual({ canViewPricing: true, canViewFinancials: true });

    vi.resetModules();
    const denied = await configureRoute({
      idempotencyKey: "legacy-random-key",
      role: "admin",
      tenantAdmin: false,
      results: [{ id: resultId }],
      commercialRows: [commercial],
      financialRows: [financial]
    });
    const deniedResponse = await denied.route.GET(request(), params());
    const deniedPayload = await deniedResponse.json();

    expect(denied.service.from).not.toHaveBeenCalled();
    expect(deniedPayload.capabilities).toEqual({
      canViewPricing: false,
      canViewFinancials: false
    });
  });

  it("hydrates capped allocation previews through the authenticated client before mapping results", async () => {
    const resultId = "00000000-0000-4000-8000-000000000020";
    const preview = Array.from({ length: 32 }, (_, index) => ({ lotKey: `preview-${index}` }));
    const complete = Array.from({ length: 40 }, (_, index) => ({ lotKey: `complete-${index}` }));
    const result = { id: resultId, allocations_trace: preview };
    const hydratedResult = { ...result, allocations_trace: complete };
    const configured = await configureRoute({
      idempotencyKey: "legacy-random-key",
      results: [result],
      hydratedResults: [hydratedResult]
    });

    const response = await configured.route.GET(request(), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(configured.hydrateUserScopedOpportunityAllocations).toHaveBeenCalledWith(
      configured.database.supabase,
      JOB_ID,
      [result]
    );
    expect(configured.resultDatabaseRow).toHaveBeenCalledWith(
      hydratedResult,
      null,
      { commercial: null, financial: null }
    );
    expect(payload.results[0].allocations_trace).toHaveLength(40);
  });

  it("paginates possible matches and rejected rows independently", async () => {
    const possibleMatch = {
      id: "possible-1",
      demand_display_mpn: "ABC",
      supply_display_mpn: "AB-C",
      reason_code: "normalized_candidate",
      explanation: "Search-normalized candidate; human review is required.",
      demand_trace: { fileName: "demand.xlsx", sheetName: "Demand", sourceRow: 12 },
      supply_trace: { fileName: "stock.xlsx", sheetName: "Stock", sourceRow: 8 }
    };
    const rejectedRow = {
      id: "rejected-1",
      file_id: "file-1",
      side: "A",
      file_name: "demand.xlsx",
      sheet_name: "Sheet1",
      source_row: 17,
      source_row_hidden: true,
      reason_code: "missing_mpn"
    };
    const { route, database } = await configureRoute({
      idempotencyKey: "legacy-random-key",
      possibleMatches: [possibleMatch],
      possibleCount: 23,
      rejectedRows: [rejectedRow],
      rejectedCount: 31
    });

    const response = await route.GET(
      request("?possibleOffset=5&possibleLimit=7&rejectedOffset=9&rejectedLimit=11"),
      params()
    );
    const payload = await response.json();

    expect(database.possibleQuery.range).toHaveBeenCalledWith(5, 11);
    expect(database.rejectedQuery.range).toHaveBeenCalledWith(9, 19);
    expect(payload.possiblePage).toEqual({ offset: 5, limit: 7, total: 23 });
    expect(payload.rejectedPage).toEqual({ offset: 9, limit: 11, total: 31 });
    expect(payload.possibleMatches[0]).toMatchObject({
      demandDisplayMpn: "ABC",
      explanation: "Search-normalized candidate; human review is required.",
      demandTrace: { fileName: "demand.xlsx", sheetName: "Demand", sourceRow: 12 },
      supplyTrace: { fileName: "stock.xlsx", sheetName: "Stock", sourceRow: 8 }
    });
    expect(payload.rejectedRows[0]).toMatchObject({ sourceRow: 17, hidden: true });
  });

  it("skips supplemental families for the terminal first page", async () => {
    const { route, database } = await configureRoute({
      idempotencyKey: "legacy-random-key",
      possibleMatches: [{ id: "possible-1" }],
      rejectedRows: [{ id: "rejected-1" }]
    });

    const response = await route.GET(request("?includeSupplemental=false"), params());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(database.possibleQuery.range).not.toHaveBeenCalled();
    expect(database.rejectedQuery.range).not.toHaveBeenCalled();
    expect(payload.possibleMatches).toEqual([]);
    expect(payload.rejectedRows).toEqual([]);
  });
});

describe("DELETE /api/opportunity-finder/jobs/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("prepares deletion before Storage and finalizes only after every removal succeeds", async () => {
    const { route, operations, rpc, remove, logAuditEvent } = await configureDeleteRoute();

    const response = await route.DELETE(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "prepare_opportunity_finder_job_deletion",
      "finalize_opportunity_finder_job_deletion"
    ]);
    const prepareIndex = operations.indexOf("rpc:prepare_opportunity_finder_job_deletion");
    const firstStorageIndex = operations.findIndex((operation) => operation.startsWith("storage.from:"));
    const lastRemoveIndex = operations.findLastIndex((operation) => operation.startsWith("storage.remove:"));
    const finalizeIndex = operations.indexOf("rpc:finalize_opportunity_finder_job_deletion");
    expect(prepareIndex).toBe(0);
    expect(firstStorageIndex).toBeGreaterThan(prepareIndex);
    expect(finalizeIndex).toBeGreaterThan(lastRemoveIndex);
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("does not query files, touch Storage, or finalize when prepare fails", async () => {
    const { route, rpc, serviceFrom, storageFrom, remove, logAuditEvent } =
      await configureDeleteRoute({ prepareError: { code: "55000" } });

    const response = await route.DELETE(request(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ errorCode: "CANCEL_JOB_BEFORE_DELETE" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("prepare_opportunity_finder_job_deletion", {
      job_id: JOB_ID,
      actor_id: OWNER_ID
    });
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(storageFrom).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("does not finalize or audit when a Storage removal fails", async () => {
    const { route, rpc, remove, logAuditEvent } = await configureDeleteRoute({
      removeError: { message: "synthetic storage failure" }
    });

    const response = await route.DELETE(request(), params());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ errorCode: "STORAGE_DELETE_FAILED" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "prepare_opportunity_finder_job_deletion"
    ]);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("refuses a non-canonical Storage reference before using service-role Storage", async () => {
    const remove = vi.fn(async () => ({ error: null }));
    const fileEq = vi.fn(async () => ({
      data: [{
        id: "00000000-0000-4000-8000-000000000020",
        job_id: JOB_ID,
        original_file_name: "demand.xlsx",
        storage_bucket: "another-private-bucket",
        storage_path: "someone-else/private.xlsx"
      }],
      error: null
    }));
    const serviceFrom = vi.fn((table: string) => {
      if (table !== "opportunity_finder_files") {
        throw new Error(`Unexpected mutation of ${table}`);
      }
      return { select: vi.fn(() => ({ eq: fileEq })) };
    });
    const service = {
      from: serviceFrom,
      rpc: vi.fn(async (name: string) => {
        if (name === "prepare_opportunity_finder_job_deletion") {
          return { data: { id: JOB_ID, status: "cancelled" }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      }),
      storage: { from: vi.fn(() => ({ remove })) }
    };
    const authSupabase = { from: vi.fn() };
    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext: vi.fn(async () => ({
        profile: { id: "00000000-0000-4000-8000-000000000001", role: "employee" },
        supabase: authSupabase,
        isDemoMode: false
      })),
      logAuditEvent: vi.fn(async () => undefined)
    }));
    vi.doMock("@/lib/opportunity-finder/api", () => ({
      cleanUuid: vi.fn((value: string) => value),
      hydrateUserScopedOpportunityAllocations: vi.fn(async (
        _supabase: unknown,
        _jobId: string,
        rows: Record<string, unknown>[]
      ) => ({
        rows,
        error: null
      })),
      loadOwnedOpportunityJob: vi.fn(async () => ({
        id: JOB_ID,
        status: "completed",
        created_by: "00000000-0000-4000-8000-000000000001"
      })),
      OPPORTUNITY_FILE_SELECT: "id",
      OPPORTUNITY_RESULT_SELECT: "id",
      resultDatabaseRow: vi.fn(),
      resultFilters: vi.fn()
    }));
    vi.doMock("@/lib/stock-needs/stock-needs", () => ({
      normalizePartNumberForMatch: vi.fn(() => "")
    }));
    vi.doMock("@/lib/security/permissions", () => ({
      getRolePermissions: vi.fn(() => ({ canViewPricing: false, canViewFinancials: false }))
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createSupabaseServiceRoleClient: vi.fn(() => service)
    }));

    const route = await import("../route");
    const response = await route.DELETE(request(), params());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ errorCode: "FILE_STORAGE_REFERENCE_INVALID" });
    expect(remove).not.toHaveBeenCalled();
    expect(serviceFrom).toHaveBeenCalledTimes(1);
    expect(service.rpc).toHaveBeenCalledWith("prepare_opportunity_finder_job_deletion", {
      job_id: JOB_ID,
      actor_id: "00000000-0000-4000-8000-000000000001"
    });
  });
});
