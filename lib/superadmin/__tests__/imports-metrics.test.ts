import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { buildSuperadminImports } from "@/lib/superadmin/metrics";

function serviceFixture(input?: {
  jobsError?: unknown;
  counterError?: unknown;
  totalError?: unknown;
}) {
  const jobs = [
    { id: "job-1", status: "queued" },
    { id: "job-2", status: "completed_with_warnings" },
    { id: "job-3", status: "failed" }
  ];
  const jobsQuery = {
    select: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async () => ({ data: jobs, error: input?.jobsError ?? null }))
  };
  jobsQuery.select.mockReturnValue(jobsQuery);
  jobsQuery.order.mockReturnValue(jobsQuery);

  const recordsQuery = {
    select: vi.fn(async () => ({ count: 15, error: input?.totalError ?? null }))
  };
  const counterQuery = {
    maybeSingle: vi.fn(async () => ({ data: { record_count: 12 }, error: input?.counterError ?? null }))
  };
  const service = {
    from: vi.fn((table: string) => table === "import_jobs" ? jobsQuery : recordsQuery),
    rpc: vi.fn(() => counterQuery)
  };

  return { service: service as unknown as SupabaseClient, serviceMock: service, jobsQuery, recordsQuery, counterQuery };
}

describe("buildSuperadminImports", () => {
  it("uses the maintained counter and a planned total instead of exact table scans", async () => {
    const fixture = serviceFixture();
    const result = await buildSuperadminImports(fixture.service);

    expect(fixture.serviceMock.rpc).toHaveBeenCalledWith("get_business_record_counter_v1");
    expect(fixture.recordsQuery.select).toHaveBeenCalledWith("id", { count: "planned", head: true });
    expect(result.summary).toMatchObject({
      queued: 1,
      completedWithWarnings: 1,
      failed: 1,
      activeBusinessRecords: 12,
      archivedBusinessRecords: 3,
      archivedBusinessRecordsApproximate: true
    });
  });

  it("surfaces counter failures without falling back to an unbounded exact count", async () => {
    const counterError = { code: "PGRST202", message: "counter unavailable" };
    const fixture = serviceFixture({ counterError });

    await expect(buildSuperadminImports(fixture.service)).rejects.toBe(counterError);
    expect(fixture.recordsQuery.select).toHaveBeenCalledTimes(1);
    expect(fixture.recordsQuery.select).not.toHaveBeenCalledWith("id", { count: "exact", head: true });
  });
});
