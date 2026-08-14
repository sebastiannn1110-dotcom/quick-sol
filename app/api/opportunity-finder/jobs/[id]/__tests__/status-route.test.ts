import { beforeEach, describe, expect, it, vi } from "vitest";

const JOB_ID = "00000000-0000-4000-8000-000000000003";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

describe("GET /api/opportunity-finder/jobs/:id/status", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("reads one owner-scoped lightweight row without terminal JSON fields", async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        id: JOB_ID,
        created_by: OWNER_ID,
        status: "processing",
        current_stage: "finding_matches",
        progress_percent: 45,
        processed_rows: 450,
        result_count: 12,
        updated_at: "2026-08-14T12:00:00.000Z"
      },
      error: null
    }));
    const secondEq = vi.fn(() => ({ maybeSingle }));
    const firstEq = vi.fn(() => ({ eq: secondEq }));
    const select = vi.fn(() => ({ eq: firstEq }));
    const from = vi.fn(() => ({ select }));

    vi.doMock("@/lib/auth/context", () => ({
      getAuthContext: vi.fn(async () => ({
        profile: { id: OWNER_ID, role: "employee" },
        supabase: { from },
        isDemoMode: false
      }))
    }));

    const route = await import("../status/route");
    const response = await route.GET(
      new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/status`),
      { params: Promise.resolve({ id: JOB_ID }) }
    );
    const payload = await response.json();
    const selectedColumns = String(select.mock.calls[0]?.[0]);

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      id: JOB_ID,
      status: "processing",
      currentStage: "finding_matches",
      progressPercent: 45,
      processedRows: 450,
      resultCount: 12
    });
    expect(firstEq).toHaveBeenCalledWith("id", JOB_ID);
    expect(secondEq).toHaveBeenCalledWith("created_by", OWNER_ID);
    expect(selectedColumns).not.toMatch(/summary_json|dataset_manifest|performance_metrics|content_pair_sha256/);
    expect(response.headers.get("server-timing")).toContain("queries:1");
  });
});
