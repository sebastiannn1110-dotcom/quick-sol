import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { OPPORTUNITY_FINDER_PIPELINE_VERSION } from "@/lib/opportunity-finder/pipeline";
import {
  getOpportunityFinderAiSummary,
  OPPORTUNITY_FINDER_AI_RESULT_SELECT
} from "@/lib/ai/opportunity-finder-tool";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000002";
const CURRENT_KEY = `opportunity-finder:v${OPPORTUNITY_FINDER_PIPELINE_VERSION}:${"a".repeat(64)}`;

function completedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    created_by: USER_ID,
    idempotency_key: CURRENT_KEY,
    status: "completed",
    matched_mpns: 12,
    result_count: 9,
    warning_count: 2,
    missing_mpn_rows: 1,
    invalid_quantity_rows: 3,
    summary_json: {
      analyzedMpns: 12,
      exactMatches: 8,
      usableAvailabilityMatches: 6,
      exactQuantityMatches: 4,
      fullSales: 4,
      partialSales: 2,
      sourcingNeeded: 2,
      supplyWithoutDemand: 1,
      reviewRequired: 3,
      invalidQuantityRows: 3
    },
    completed_at: "2026-07-30T12:00:00.000Z",
    ...overrides
  };
}

function resultRow(overrides: Record<string, unknown> = {}) {
  return {
    opportunity_type: "full_sale",
    exact_match: true,
    usable_availability_match: true,
    exact_quantity_match: true,
    display_mpn: "000-QA-101",
    required_qty: 10,
    available_qty: 10,
    allocated_qty: 10,
    shortage_qty: 0,
    coverage_percent: 100,
    required_date: "2026-08-01",
    unit_of_measure: "EA",
    reason_code: "full_coverage",
    action_code: "offer_full_quantity",
    warnings: [],
    // These fields simulate an over-broad database row and must never escape.
    id: JOB_ID,
    job_id: JOB_ID,
    demand_file_name: "private-demand.xlsx",
    supply_file_name: "private-stock.xlsx",
    manufacturer: "Private Manufacturer",
    customer_context: "Private Customer",
    supplier_context: "Private Supplier",
    unit_cost: 123.45,
    ...overrides
  };
}

function createMock(options: {
  job?: Record<string, unknown> | null;
  results?: Record<string, unknown>[];
  count?: number;
} = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const job = options.job === undefined ? completedJob() : options.job;
  const results = options.results ?? [resultRow()];

  type QueryMethod =
    | "select"
    | "eq"
    | "in"
    | "like"
    | "order"
    | "limit"
    | "or"
    | "range"
    | "maybeSingle";
  type QueryMock = Record<QueryMethod, ReturnType<typeof vi.fn>>;

  function chain(table: string): QueryMock {
    const target = {} as QueryMock;
    for (const method of ["select", "eq", "in", "like", "order", "limit", "or", "range"]) {
      target[method] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method, args });
        if (method === "range") {
          return Promise.resolve({ data: results, error: null, count: options.count ?? results.length });
        }
        return target;
      });
    }
    target.maybeSingle = vi.fn(async () => {
      calls.push({ table, method: "maybeSingle", args: [] });
      return { data: job, error: null };
    });
    return target;
  }

  const tables = new Map<string, QueryMock>();
  const mutationMethods = {
    insert: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    rpc: vi.fn()
  };
  const supabase = {
    from: vi.fn((table: string) => {
      if (!tables.has(table)) tables.set(table, chain(table));
      return tables.get(table);
    }),
    ...mutationMethods
  };
  return {
    supabase: supabase as unknown as SupabaseClient,
    calls,
    mutationMethods
  };
}

describe("Opportunity Finder V2 AI summary tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the latest owned completed V2 job through the authenticated client", async () => {
    const mock = createMock();
    const result = await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      language: "en"
    });

    expect(result.status).toBe("ok");
    expect(mock.calls).toEqual(expect.arrayContaining([
      { table: "opportunity_finder_jobs", method: "eq", args: ["created_by", USER_ID] },
      {
        table: "opportunity_finder_jobs",
        method: "in",
        args: ["status", ["completed", "completed_with_warnings"]]
      },
      {
        table: "opportunity_finder_jobs",
        method: "like",
        args: ["idempotency_key", `opportunity-finder:v${OPPORTUNITY_FINDER_PIPELINE_VERSION}:%`]
      }
    ]));
    expect(mock.calls.some((call) => call.table === "opportunity_finder_rows")).toBe(false);
  });

  it("applies ownership to an explicit job and rejects a V1 result without fallback", async () => {
    const mock = createMock({
      job: completedJob({ idempotency_key: `opportunity-finder:v1:${"b".repeat(64)}` })
    });
    const result = await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      jobId: JOB_ID,
      language: "es"
    });

    expect(mock.calls).toEqual(expect.arrayContaining([
      { table: "opportunity_finder_jobs", method: "eq", args: ["id", JOB_ID] },
      { table: "opportunity_finder_jobs", method: "eq", args: ["created_by", USER_ID] }
    ]));
    expect(result.status).toBe("incompatible_pipeline");
    expect(result.items).toEqual([]);
    expect(result.summary).toContain("versión anterior");
    expect(mock.calls.some((call) => call.table === "opportunity_finder_results")).toBe(false);
  });

  it("returns a localized no-job answer and does not fall back to historical data", async () => {
    const mock = createMock({ job: null });
    const result = await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      language: "zh"
    });

    expect(result.status).toBe("no_completed_job");
    expect(result.summary).toContain("没有可用");
    expect(result.items).toEqual([]);
    expect(mock.calls.some((call) => call.table === "business_records")).toBe(false);
    expect(mock.calls.some((call) => call.table === "opportunity_finder_results")).toBe(false);
  });

  it("returns only safe fields and sanitized counts", async () => {
    const mock = createMock({
      count: 9,
      results: [resultRow({ display_mpn: `PART-${JOB_ID}` })]
    });
    const result = await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      limit: 500,
      offset: -20
    });

    expect(result.metrics).toEqual(expect.objectContaining({
      analyzedMpns: 12,
      exactMatches: 8,
      usableAvailabilityMatches: 6,
      exactQuantityMatches: 4,
      invalidQuantityRows: 3,
      resultCount: 9
    }));
    expect(result.page).toEqual({ offset: 0, limit: 50, total: 9, truncated: false });
    expect(mock.calls).toContainEqual({
      table: "opportunity_finder_results",
      method: "range",
      args: [0, 49]
    });
    expect(result.items[0]?.displayMpn).toBe("PART-");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(JOB_ID);
    expect(serialized).not.toContain("private-demand.xlsx");
    expect(serialized).not.toContain("Private Manufacturer");
    expect(serialized).not.toContain("Private Customer");
    expect(serialized).not.toContain("Private Supplier");
    expect(serialized).not.toContain("123.45");
    expect(OPPORTUNITY_FINDER_AI_RESULT_SELECT).not.toMatch(
      /(?:^|,)(?:id|job_id|.*file.*|manufacturer|customer_context|supplier_context|.*cost.*)(?:,|$)/
    );
  });

  it.each([
    ["full_sale", "opportunity_type", "full_sale"],
    ["partial_sale", "opportunity_type", "partial_sale"],
    ["sourcing_needed", "opportunity_type", "sourcing_needed"],
    ["supply_without_demand", "opportunity_type", "supply_without_demand"],
    ["exactMpn", "exact_match", true],
    ["usableAvailability", "usable_availability_match", true],
    ["exactQuantity", "exact_quantity_match", true],
    ["review", "opportunity_type", "review_required"]
  ] as const)("filters mode %s at the database", async (mode, column, value) => {
    const mock = createMock();
    await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      mode
    });
    expect(mock.calls).toContainEqual({
      table: "opportunity_finder_results",
      method: "eq",
      args: [column, value]
    });
  });

  it("filters invalid quantities without accepting user-controlled filter syntax", async () => {
    const mock = createMock();
    await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      mode: "invalid_quantity"
    });
    expect(mock.calls).toContainEqual({
      table: "opportunity_finder_results",
      method: "or",
      args: [
        'reason_code.eq.invalid_quantity,warnings.cs.["invalid_required_quantity"],warnings.cs.["invalid_available_quantity"]'
      ]
    });
  });

  it("never invokes mutation, RPC, storage, or matcher operations", async () => {
    const mock = createMock();
    await getOpportunityFinderAiSummary({
      supabase: mock.supabase,
      userId: USER_ID,
      mode: "general"
    });

    for (const operation of Object.values(mock.mutationMethods)) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(mock.calls.every((call) => [
      "opportunity_finder_jobs",
      "opportunity_finder_results"
    ].includes(call.table))).toBe(true);
  });
});
