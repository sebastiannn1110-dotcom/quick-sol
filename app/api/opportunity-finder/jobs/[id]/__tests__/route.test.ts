import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";

function createSupabaseMock() {
  const filesTable = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        order: vi.fn(async () => ({ data: [], error: null }))
      }))
    }))
  };
  const resultsQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  resultsQuery.eq = vi.fn(() => resultsQuery);
  resultsQuery.order = vi.fn(() => resultsQuery);
  resultsQuery.range = vi.fn(async () => ({ data: [], error: null, count: 0 }));
  const resultsTable = { select: vi.fn(() => resultsQuery) };
  const possibleTable = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        order: vi.fn(() => ({
          limit: vi.fn(async () => ({ data: [], error: null }))
        }))
      }))
    }))
  };
  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === "opportunity_finder_files") return filesTable;
        if (table === "opportunity_finder_results") return resultsTable;
        return possibleTable;
      })
    },
    resultsQuery
  };
}

async function configureRoute(
  idempotencyKey: string | null,
  filterOverrides: Record<string, unknown> = {}
) {
  const { supabase, resultsQuery } = createSupabaseMock();
  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: { id: "00000000-0000-4000-8000-000000000001" },
      supabase,
      isDemoMode: false
    }))
  }));
  vi.doMock("@/lib/stock-needs/stock-needs", () => ({
    normalizePartNumberForMatch: vi.fn(() => "")
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => ({}))
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn((value: string) => value),
    loadOwnedOpportunityJob: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000003",
      idempotency_key: idempotencyKey,
      status: "completed",
      current_stage: "completed",
      progress_percent: 100,
      summary_json: {},
      created_at: "2026-07-29T12:00:00.000Z"
    })),
    OPPORTUNITY_FILE_SELECT: "id",
    OPPORTUNITY_RESULT_SELECT: "id",
    resultDatabaseRow: vi.fn((row) => row),
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
      ...filterOverrides
    }))
  }));
  const route = await import("../route");
  return { route, supabase, resultsQuery };
}

describe("GET /api/opportunity-finder/jobs/:id pipeline version", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns the version encoded in a current idempotency key", async () => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      attemptId: "same-attempt",
      files: [
        { side: "A", fileName: "demand.xlsx", fileSize: 100 },
        { side: "B", fileName: "stock.xlsx", fileSize: 200 }
      ]
    });
    const { route } = await configureRoute(idempotencyKey);

    const response = await route.GET(
      new Request("https://app.test/api/opportunity-finder/jobs/00000000-0000-4000-8000-000000000003"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }) }
    );
    const payload = await response.json();

    expect(payload.job.pipelineVersion).toBe(OPPORTUNITY_FINDER_PIPELINE_VERSION);
  });

  it("returns null for a legacy unversioned job", async () => {
    const { route } = await configureRoute("legacy-random-key");

    const response = await route.GET(
      new Request("https://app.test/api/opportunity-finder/jobs/00000000-0000-4000-8000-000000000003"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }) }
    );
    const payload = await response.json();

    expect(payload.job.pipelineVersion).toBeNull();
  });

  it("filters usable availability instead of the original aggregate quantity", async () => {
    const { route, resultsQuery } = await configureRoute("legacy-random-key", {
      withAvailable: true
    });

    await route.GET(
      new Request("https://app.test/api/opportunity-finder/jobs/00000000-0000-4000-8000-000000000003"),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }) }
    );

    expect(resultsQuery.eq).toHaveBeenCalledWith("usable_availability_match", true);
    expect(resultsQuery.eq).not.toHaveBeenCalledWith("available_qty", 0);
  });
});
