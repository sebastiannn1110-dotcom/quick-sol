import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "employee"
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const requestBody = {
  files: [
    {
      side: "A",
      fileName: "synthetic-demand.xlsx",
      fileSize: 1200,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentSha256: HASH_A
    },
    {
      side: "B",
      fileName: "synthetic-stock.xlsx",
      fileSize: 950,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentSha256: HASH_B
    }
  ]
};

function createRequest(body: Record<string, unknown> = requestBody) {
  return new Request("https://app.test/api/opportunity-finder/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function createSupabaseMock(input: {
  existing: Record<string, unknown>;
  conflictOnInsert?: boolean;
}) {
  const maybeSingle = vi.fn();
  if (input.conflictOnInsert) {
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: input.existing, error: null });
  } else {
    maybeSingle.mockResolvedValue({ data: input.existing, error: null });
  }
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.eq = vi.fn(() => query);
  query.maybeSingle = maybeSingle;
  const table = {
    select: vi.fn(() => query),
    insert: vi.fn(async () => ({
      error: input.conflictOnInsert ? { code: "23505" } : null
    }))
  };
  return {
    supabase: { from: vi.fn(() => table) },
    query,
    table,
    maybeSingle
  };
}

async function configureRoute(supabase: unknown, service: unknown = supabase) {
  const getAuthContext = vi.fn(async () => ({
    user: null,
    profile,
    supabase,
    isDemoMode: false,
    requestMeta: {
      route: "/api/opportunity-finder/jobs",
      traceId: "trace-id",
      requestId: "request-id"
    }
  }));
  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext,
    logAuditEvent: vi.fn(async () => undefined)
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => service)
  }));
  vi.doMock("@/lib/security/rateLimit", () => ({
    checkRateLimit: vi.fn(() => ({ allowed: true, resetAt: Date.now() + 1000 })),
    rateLimitResponse: vi.fn()
  }));
  vi.doMock("@/lib/logger/logger", () => ({
    logger: { info: vi.fn(async () => undefined) }
  }));
  return import("../route");
}

function createSuccessfulCreationMock() {
  const existingQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  existingQuery.eq = vi.fn(() => existingQuery);
  existingQuery.maybeSingle = vi.fn(async () => ({ data: null, error: null }));

  const mutationQuery: Record<string, unknown> = { error: null };
  mutationQuery.eq = vi.fn(() => mutationQuery);
  const authenticatedJobsTable = {
    select: vi.fn(() => existingQuery)
  };
  const jobsTable = {
    insert: vi.fn(async () => ({ error: null })),
    update: vi.fn(() => mutationQuery)
  };
  const filesTable = {
    insert: vi.fn(async () => ({ error: null }))
  };
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "opportunity_finder_jobs") return authenticatedJobsTable;
      throw new Error(`Authenticated client cannot mutate ${table}`);
    })
  };
  const createSignedUploadUrl = vi.fn(async (storagePath: string) => ({
    data: { signedUrl: `https://storage.test/${storagePath}`, token: "token", path: storagePath },
    error: null
  }));
  const service = {
    from: vi.fn((table: string) => table === "opportunity_finder_jobs" ? jobsTable : filesTable),
    storage: { from: vi.fn(() => ({ createSignedUploadUrl })) }
  };
  return { supabase, service, jobsTable, filesTable };
}

describe("POST /api/opportunity-finder/jobs idempotency", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([
    "uploading",
    "queued",
    "matching",
    "completed",
    "completed_with_warnings",
    "failed",
    "cancelled"
  ])("returns a structured 409 when the existing job is %s", async (status) => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      files: requestBody.files as Parameters<typeof buildOpportunityFinderIdempotencyKey>[0]["files"]
    });
    const existing = {
      id: "00000000-0000-4000-8000-000000000003",
      status,
      created_at: "2026-07-29T12:00:00.000Z",
      idempotency_key: idempotencyKey
    };
    const mock = createSupabaseMock({ existing });
    const { POST } = await configureRoute(mock.supabase);

    const response = await POST(createRequest());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      code: "COMPARISON_ALREADY_EXISTS",
      errorCode: "COMPARISON_ALREADY_EXISTS",
      jobId: existing.id,
      status,
      reusedExistingJob: true,
      createdAt: existing.created_at,
      pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION
    });
    expect(mock.query.eq).toHaveBeenCalledWith("idempotency_key", idempotencyKey);
    expect(mock.query.eq).toHaveBeenCalledWith("tenant_id", profile.id);
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
    expect(JSON.stringify(payload)).not.toContain(HASH_B);
  });

  it("converts a concurrent unique-key collision into the same structured 409", async () => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      files: requestBody.files as Parameters<typeof buildOpportunityFinderIdempotencyKey>[0]["files"]
    });
    const existing = {
      id: "00000000-0000-4000-8000-000000000004",
      status: "completed",
      created_at: "2026-07-29T12:00:00.000Z",
      idempotency_key: idempotencyKey
    };
    const mock = createSupabaseMock({ existing, conflictOnInsert: true });
    const { POST } = await configureRoute(mock.supabase);

    const response = await POST(createRequest());
    const payload = await response.json();

    expect(mock.table.insert).toHaveBeenCalledOnce();
    expect(mock.maybeSingle).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(409);
    expect(payload.reusedExistingJob).toBe(true);
    expect(payload.pipelineVersion).toBe(OPPORTUNITY_FINDER_PIPELINE_VERSION);
  });

  it("identifies a completed legacy zero-result scenario as reused instead of newly processed", async () => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      files: requestBody.files as Parameters<typeof buildOpportunityFinderIdempotencyKey>[0]["files"]
    });
    const existing = {
      id: "00000000-0000-4000-8000-000000000005",
      status: "completed",
      result_count: 0,
      created_at: "2026-07-29T12:00:00.000Z",
      idempotency_key: idempotencyKey
    };
    const mock = createSupabaseMock({ existing });
    const { POST } = await configureRoute(mock.supabase);

    const response = await POST(createRequest());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.jobId).toBe(existing.id);
    expect(payload.reusedExistingJob).toBe(true);
    expect(payload).not.toHaveProperty("files");
  });

  it.each([
    undefined,
    "not-a-sha256",
    "A".repeat(64),
    `${"a".repeat(63)}g`
  ])("rejects a missing or malformed declared content hash: %s", async (contentSha256) => {
    const mock = createSupabaseMock({ existing: {} });
    const { POST } = await configureRoute(mock.supabase);
    const invalidBody = {
      ...requestBody,
      files: requestBody.files.map((file, index) => index === 0
        ? { ...file, contentSha256 }
        : file)
    };

    const response = await POST(createRequest(invalidBody));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ errorCode: "FILE_HASH_INVALID" });
    expect(mock.supabase.from).not.toHaveBeenCalled();
  });

  it("stores each declared hash as pending verification without returning either hash", async () => {
    const mock = createSuccessfulCreationMock();
    const { POST } = await configureRoute(mock.supabase, mock.service);
    const expectedIdempotencyKey = await buildOpportunityFinderIdempotencyKey({
      files: requestBody.files
    });

    const response = await POST(createRequest());
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(mock.service.from).toHaveBeenCalledWith("opportunity_finder_jobs");
    expect(mock.service.from).toHaveBeenCalledWith("opportunity_finder_files");
    expect(mock.supabase.from).toHaveBeenCalledTimes(1);
    expect(mock.jobsTable.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: profile.id,
      created_by: profile.id,
      pipeline_version: OPPORTUNITY_FINDER_PIPELINE_VERSION,
      idempotency_key: expectedIdempotencyKey
    }));
    expect(mock.filesTable.insert).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        side: "A",
        content_sha256: HASH_A,
        validation_status: "pending"
      }),
      expect.objectContaining({
        side: "B",
        content_sha256: HASH_B,
        validation_status: "pending"
      })
    ]));
    expect(JSON.stringify(payload)).not.toContain(HASH_A);
    expect(JSON.stringify(payload)).not.toContain(HASH_B);
  });
});
