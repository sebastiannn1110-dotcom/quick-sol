import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  role: "employee"
};

const requestBody = {
  files: [
    {
      side: "A",
      fileName: "synthetic-demand.xlsx",
      fileSize: 1200,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    },
    {
      side: "B",
      fileName: "synthetic-stock.xlsx",
      fileSize: 950,
      fileType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
  ],
  idempotencyKey: "00000000-0000-4000-8000-000000000002"
};

function createRequest() {
  return new Request("https://app.test/api/opportunity-finder/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
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

async function configureRoute(supabase: unknown) {
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
  vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  vi.doMock("@/lib/supabase/server", () => ({
    createSupabaseServiceRoleClient: vi.fn(() => ({}))
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
      attemptId: requestBody.idempotencyKey,
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
  });

  it("converts a concurrent unique-key collision into the same structured 409", async () => {
    const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
      attemptId: requestBody.idempotencyKey,
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
      attemptId: requestBody.idempotencyKey,
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
});
