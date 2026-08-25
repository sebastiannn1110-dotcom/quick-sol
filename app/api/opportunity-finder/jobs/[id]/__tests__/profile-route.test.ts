import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000003";
const FILE_A_ID = "00000000-0000-4000-8000-000000000011";
const FILE_B_ID = "00000000-0000-4000-8000-000000000012";

const files = [
  {
    id: FILE_A_ID,
    job_id: JOB_ID,
    original_file_name: "demand.xlsx",
    storage_bucket: "opportunity-finder",
    storage_path: `${USER_ID}/${JOB_ID}/${FILE_A_ID}.xlsx`,
    size_bytes: 101
  },
  {
    id: FILE_B_ID,
    job_id: JOB_ID,
    original_file_name: "supply.xlsx",
    storage_bucket: "opportunity-finder",
    storage_path: `${USER_ID}/${JOB_ID}/${FILE_B_ID}.xlsx`,
    size_bytes: 202
  }
];

async function configureProfileRoute(options: {
  queueError?: { code: string } | null;
} = {}) {
  const filesEq = vi.fn(async () => ({ data: files, error: null }));
  const filesTable = {
    select: vi.fn(() => ({ eq: filesEq }))
  };
  const authSupabase = {
    from: vi.fn((table: string) => {
      if (table !== "opportunity_finder_files") {
        throw new Error(`Unexpected auth query ${table}`);
      }
      return filesTable;
    })
  };
  const list = vi.fn(async (_folder: string, input: { search: string }) => {
    const file = files.find((candidate) => candidate.storage_path.endsWith(`/${input.search}`));
    return {
      data: file ? [{ name: input.search, metadata: { size: file.size_bytes } }] : [],
      error: null
    };
  });
  const storageFrom = vi.fn(() => ({ list }));
  const directFrom = vi.fn(() => {
    throw new Error("Profile transition must not use a direct service-role table update");
  });
  const rpc = vi.fn(async (name: string) => {
    if (name !== "queue_opportunity_finder_profile") {
      throw new Error(`Unexpected RPC ${name}`);
    }
    return options.queueError
      ? { data: null, error: options.queueError }
      : { data: { id: JOB_ID, status: "queued" }, error: null };
  });
  const service = {
    from: directFrom,
    rpc,
    storage: { from: storageFrom }
  };
  const logAuditEvent = vi.fn(async () => undefined);

  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: { id: USER_ID, role: "employee" },
      supabase: authSupabase,
      isDemoMode: false
    })),
    logAuditEvent
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn((value: string) => value),
    loadOwnedOpportunityJob: vi.fn(async () => ({
      id: JOB_ID,
      status: "uploading",
      created_by: USER_ID
    }))
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => service)
  }));

  const route = await import("../profile/route");
  return { route, authSupabase, directFrom, rpc, storageFrom, logAuditEvent };
}

function request() {
  return new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/profile`, {
    method: "POST"
  });
}

function params() {
  return { params: Promise.resolve({ id: JOB_ID }) };
}

describe("POST /api/opportunity-finder/jobs/:id/profile", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("queues profiling through the fenced RPC without direct table updates", async () => {
    const { route, authSupabase, directFrom, rpc, storageFrom, logAuditEvent } =
      await configureProfileRoute();

    const response = await route.POST(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jobId: JOB_ID,
      status: "queued",
      currentStage: "inspecting_sheets"
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("queue_opportunity_finder_profile", {
      job_id: JOB_ID,
      actor_id: USER_ID,
      expected_status: "uploading",
      uploaded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    expect(authSupabase.from).toHaveBeenCalledTimes(1);
    expect(storageFrom).toHaveBeenCalledTimes(2);
    expect(directFrom).not.toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for a stale queue transition without falling back to direct updates", async () => {
    const { route, directFrom, rpc, logAuditEvent } = await configureProfileRoute({
      queueError: { code: "40001" }
    });

    const response = await route.POST(request(), params());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ errorCode: "JOB_QUEUE_CONFLICT" });
    expect(rpc).toHaveBeenCalledWith("queue_opportunity_finder_profile", expect.objectContaining({
      job_id: JOB_ID,
      actor_id: USER_ID,
      expected_status: "uploading"
    }));
    expect(directFrom).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
