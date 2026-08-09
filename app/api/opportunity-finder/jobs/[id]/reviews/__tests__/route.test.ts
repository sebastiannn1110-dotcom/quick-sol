import { beforeEach, describe, expect, it, vi } from "vitest";

const JOB_ID = "00000000-0000-4000-8000-000000000003";
const ENTITY_ID = "00000000-0000-4000-8000-000000000020";

async function configureRoute(options?: {
  owned?: boolean;
  rpcError?: { code?: string } | null;
}) {
  const rpc = vi.fn(async () => ({
    data: "approved",
    error: options?.rpcError ?? null
  }));
  const logAuditEvent = vi.fn(async () => undefined);
  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => ({
      profile: { id: "00000000-0000-4000-8000-000000000001", role: "employee" },
      supabase: { rpc },
      isDemoMode: false
    })),
    logAuditEvent
  }));
  vi.doMock("@/lib/opportunity-finder/api", () => ({
    cleanUuid: vi.fn((value: string) => value),
    loadOwnedOpportunityJob: vi.fn(async () => options?.owned === false ? null : ({ id: JOB_ID }))
  }));
  vi.doMock("@/lib/security/rateLimit", () => ({
    checkRateLimit: vi.fn(() => ({ allowed: true, resetAt: Date.now() + 60_000 })),
    rateLimitResponse: vi.fn()
  }));
  return {
    route: await import("../route"),
    rpc,
    logAuditEvent
  };
}

function request(body: Record<string, unknown>) {
  return new Request(`https://app.test/api/opportunity-finder/jobs/${JOB_ID}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

const params = { params: Promise.resolve({ id: JOB_ID }) };

describe("POST /api/opportunity-finder/jobs/:id/reviews", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("routes the decision through one atomic database RPC", async () => {
    const { route, rpc, logAuditEvent } = await configureRoute();

    const response = await route.POST(request({
      entityType: "possible_match",
      entityId: ENTITY_ID,
      decision: "approved",
      note: "Manufacturer alias verified"
    }), params);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("decide_opportunity_finder_review", {
      job_id: JOB_ID,
      entity_type: "possible_match",
      entity_id: ENTITY_ID,
      decision: "approved",
      review_note: "Manufacturer alias verified"
    });
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "opportunity_finder_review_decided",
      "possible_match",
      ENTITY_ID,
      { jobId: JOB_ID, decision: "approved" }
    );
    expect(payload.reviewStatus).toBe("approved");
  });

  it("does not invoke the review RPC for a job outside the authenticated owner scope", async () => {
    const { route, rpc } = await configureRoute({ owned: false });

    const response = await route.POST(request({
      entityType: "result",
      entityId: ENTITY_ID,
      decision: "rejected"
    }), params);

    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps an atomic RPC missing-target error to a safe 404", async () => {
    const { route } = await configureRoute({ rpcError: { code: "P0002" } });

    const response = await route.POST(request({
      entityType: "result",
      entityId: ENTITY_ID,
      decision: "approved"
    }), params);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload).toEqual({ errorCode: "REVIEW_TARGET_NOT_FOUND" });
  });
});
