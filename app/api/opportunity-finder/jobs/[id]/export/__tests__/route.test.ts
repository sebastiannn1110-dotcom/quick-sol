import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const JOB_ID = "00000000-0000-4000-8000-000000000003";
const RESULT_ID = "00000000-0000-4000-8000-000000000004";

function uuid(value: string | null | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

async function configureRoute(
  resultRows: Record<string, unknown>[] = [],
  options: { rateAllowed?: boolean } = {}
) {
  const resultQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  resultQuery.eq = vi.fn(() => resultQuery);
  resultQuery.order = vi.fn(() => resultQuery);
  resultQuery.range = vi.fn(async (from: number, to: number) => ({
    data: resultRows.slice(from, to + 1),
    error: null
  }));
  const resultsTable = {
    select: vi.fn(() => resultQuery)
  };
  const supabase = {
    from: vi.fn((table: string) => {
      if (table !== "opportunity_finder_results") {
        throw new Error(`Individual export unexpectedly queried ${table}`);
      }
      return resultsTable;
    })
  };
  const loadOwnedOpportunityJob = vi.fn(async () => ({
    id: JOB_ID,
    status: "completed",
    idempotency_key: "pipeline-v2",
    summary_json: { fullSales: 99 }
  }));
  const logAuditEvent = vi.fn(async () => undefined);

  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: { id: "00000000-0000-4000-8000-000000000001", role: "employee" },
      supabase,
      isDemoMode: false
    })),
    logAuditEvent
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn(uuid),
    loadOwnedOpportunityJob,
    OPPORTUNITY_RESULT_SELECT: "id,job_id,created_at",
    resultDatabaseRow: vi.fn((row) => row)
  }));
  vi.doMock("@/lib/opportunity-finder/pipeline", () => ({
    opportunityFinderPipelineVersionFromKey: vi.fn(() => "2")
  }));
  vi.doMock("@/lib/security/permissions", () => ({
    canViewSensitivePricing: vi.fn(() => false),
    canViewCosts: vi.fn(() => false),
    canViewGp: vi.fn(() => false)
  }));
  vi.doMock("@/lib/security/persistent-rate-limit", () => ({
    checkPersistentRateLimit: vi.fn(async () => ({
      allowed: options.rateAllowed !== false,
      remaining: options.rateAllowed === false ? 0 : 9,
      resetAt: Date.now() + 60_000,
      persistent: true
    }))
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => null)
  }));
  // This suite validates route orchestration, authorization, pagination and
  // cleanup. Workbook behavior has its own focused tests. Mocking the export
  // module keeps ExcelJS initialization outside each resetModules() cycle,
  // which otherwise consumed the test timeout under full-suite CPU pressure
  // before the invalid-resultId branch could execute.
  vi.doMock("@/lib/opportunity-finder/export", () => ({
    OpportunityExportTooLargeError: class OpportunityExportTooLargeError extends Error {
      sheetName = "Synthetic";
    },
    OpportunityStreamingExportWriter: class OpportunityStreamingExportWriter {
      addResults() {}
      addPossibleMatches() {}
      addRejectedRows() {}
      async commit() {
        return { resultCount: 0, possibleMatchCount: 0, rejectedRowCount: 0, sheetCount: 9 };
      }
      abort() {}
    },
    opportunityCsvHeaderLine: vi.fn(() => "id"),
    opportunityCsvResultLine: vi.fn((result: { id?: string }) => String(result.id ?? "")),
    buildOpportunityCsv: vi.fn(),
    buildOpportunityExportWorkbook: vi.fn(),
    classifyOpportunityForExport: vi.fn(),
    exportHeaders: vi.fn(),
    exportRow: vi.fn(),
    OPPORTUNITY_EXPORT_SHEET_NAMES: [],
    safeSpreadsheetValue: vi.fn((value: unknown) => value)
  }));

  const route = await import("../route");
  return { route, resultQuery, supabase, loadOwnedOpportunityJob, logAuditEvent };
}

function exportableResult(id = RESULT_ID) {
  return {
    id,
    jobId: JOB_ID,
    opportunityType: "full_sale",
    exactMpnMatch: true,
    exactMatch: true,
    usableAvailabilityMatch: true,
    exactQuantityMatch: true,
    displayMpn: "SAFE-MPN",
    normalizedMpn: "SAFE-MPN",
    manufacturer: "Safe manufacturer",
    customerContext: "Safe context",
    supplierContext: "Safe supplier",
    requiredQty: 10,
    availableQty: 10,
    allocatedQty: 10,
    shortageQty: 0,
    coveragePercent: 100,
    requiredDate: null,
    unitOfMeasure: "EA",
    demandFileId: "00000000-0000-4000-8000-000000000011",
    demandFileName: "demand.xlsx",
    demandSheetName: "Demand",
    supplyFileId: "00000000-0000-4000-8000-000000000012",
    supplyFileName: "supply.xlsx",
    supplySheetName: "Supply",
    demandSourceRows: 1,
    supplySourceRows: 1,
    reasonCode: "full_coverage",
    actionCode: "offer_full_quantity",
    warnings: []
  };
}

describe("Opportunity Finder individual export validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns 400 for a present but invalid resultId instead of silently exporting the whole job", async () => {
    const { route, supabase, loadOwnedOpportunityJob } = await configureRoute();
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/export?resultId=not-a-uuid`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ errorCode: "INVALID_RESULT_ID" });
    expect(loadOwnedOpportunityJob).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("scopes a valid individual result to the owned job and returns 404 without querying unrelated datasets", async () => {
    const { route, resultQuery, supabase } = await configureRoute([]);
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/export?resultId=${RESULT_ID}`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ errorCode: "RESULT_NOT_FOUND" });
    expect(resultQuery.eq).toHaveBeenCalledWith("job_id", JOB_ID);
    expect(resultQuery.eq).toHaveBeenCalledWith("id", RESULT_ID);
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("opportunity_finder_results");
  });

  it("rate limits exports per authenticated user before loading the owned job", async () => {
    const { route, loadOwnedOpportunityJob } = await configureRoute([], { rateAllowed: false });
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/export`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ errorCode: "EXPORT_RATE_LIMITED" });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(loadOwnedOpportunityJob).not.toHaveBeenCalled();
  });

  it("streams CSV from paginated result queries and audits only non-sensitive metadata", async () => {
    const tempBefore = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith("quik-opportunity-export-"))
    );
    const rows = Array.from({ length: 501 }, (_, index) => exportableResult(
      `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`
    ));
    const { route, resultQuery, logAuditEvent } = await configureRoute(rows);
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/export?format=csv`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-length")).toMatch(/^\d+$/);
    const csv = await response.text();
    expect(csv.split("\r\n")).toHaveLength(502);
    expect(resultQuery.range).toHaveBeenNthCalledWith(1, 0, 499);
    expect(resultQuery.range).toHaveBeenNthCalledWith(2, 500, 999);

    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const metadata = logAuditEvent.mock.calls[0]?.[4] as Record<string, unknown>;
    expect(metadata).toMatchObject({
      format: "csv",
      scope: "full_job",
      resultCount: 501,
      pricingIncluded: false,
      financialsIncluded: false
    });
    expect(Object.keys(metadata)).not.toEqual(expect.arrayContaining(["mpn", "price", "raw"]));
    expect(JSON.stringify(metadata)).not.toContain("SAFE-MPN");
    const leakedTempDirectories = (await readdir(tmpdir())).filter(
      (entry) => entry.startsWith("quik-opportunity-export-") && !tempBefore.has(entry)
    );
    expect(leakedTempDirectories).toEqual([]);
  });

  it("removes the temporary export when the response consumer cancels", async () => {
    const tempBefore = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith("quik-opportunity-export-"))
    );
    const { route } = await configureRoute([exportableResult()]);
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/export?format=csv&resultId=${RESULT_ID}`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );

    expect(response.status).toBe(200);
    await response.body?.cancel("test cancellation");
    const leakedTempDirectories = (await readdir(tmpdir())).filter(
      (entry) => entry.startsWith("quik-opportunity-export-") && !tempBefore.has(entry)
    );
    expect(leakedTempDirectories).toEqual([]);
  });
});
