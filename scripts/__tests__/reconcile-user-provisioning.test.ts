import { describe, expect, it, vi } from "vitest";
import {
  executeReconciliation,
  parseReconciliationArgs,
  type ReconciliationGateway
} from "../reconcile-user-provisioning";

const PROJECT_REF = "abcdefghijklmnopqrst";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const INTENT_ID = "84000000-0000-4000-8000-000000000001";
const ACTOR_ID = "84000000-0000-4000-8000-000000000002";

function gateway(): ReconciliationGateway {
  return {
    preview: vi.fn(async () => [
      {
        intent_id: INTENT_ID,
        technical_auth_user_id: null,
        classification: "PENDING_NO_AUTH",
        locator_channel: "NONE",
        intent_status: "pending",
        created_at: new Date(0).toISOString(),
        completed_at: null
      }
    ]),
    previewOrphans: vi.fn(async () => [
      {
        technical_auth_user_id: INTENT_ID,
        classification: "HISTORICAL_AUTH_NO_PROFILE_NO_INTENT",
        created_at: new Date(0).toISOString()
      }
    ]),
    apply: vi.fn(async () => ({ state: "RECONCILED", intent_id: INTENT_ID }))
  };
}

function dependencies(mockGateway: ReconciliationGateway) {
  return {
    createGateway: vi.fn(() => mockGateway),
    log: vi.fn<(message: string) => void>(),
    supabaseUrl: SUPABASE_URL
  };
}

describe("user provisioning reconciliation CLI", () => {
  it("defaults to a read-only preview and accepts an optional technical intent filter", () => {
    expect(
      parseReconciliationArgs([`--project-ref=${PROJECT_REF}`, `--intent-id=${INTENT_ID}`])
    ).toEqual({
      mode: "preview",
      projectRef: PROJECT_REF,
      intentId: INTENT_ID
    });
  });

  it("keeps orphan diagnosis separate and forbids apply arguments", () => {
    expect(parseReconciliationArgs(["--orphans", `--project-ref=${PROJECT_REF}`])).toEqual({
      mode: "orphans",
      projectRef: PROJECT_REF,
      intentId: undefined
    });
    expect(() =>
      parseReconciliationArgs([
        "--orphans",
        `--project-ref=${PROJECT_REF}`,
        `--actor-profile-id=${ACTOR_ID}`
      ])
    ).toThrow("ORPHAN_PREVIEW_FILTER_FORBIDDEN");
  });

  it("requires explicit intent, SuperAdmin actor and reason for apply", () => {
    expect(() =>
      parseReconciliationArgs(["--apply", `--project-ref=${PROJECT_REF}`])
    ).toThrow("ACTOR_PROFILE_ID_REQUIRED");

    expect(
      parseReconciliationArgs([
        "--apply",
        `--project-ref=${PROJECT_REF}`,
        `--intent-id=${INTENT_ID}`,
        `--actor-profile-id=${ACTOR_ID}`,
        "--reason=Validated historical response loss"
      ])
    ).toMatchObject({
      mode: "apply",
      intentId: INTENT_ID,
      actorProfileId: ACTOR_ID,
      reason: "Validated historical response loss"
    });
  });

  it("previews without mutations", async () => {
    const mockGateway = gateway();
    const result = await executeReconciliation(
      { mode: "preview", projectRef: PROJECT_REF, intentId: INTENT_ID },
      dependencies(mockGateway)
    );

    expect(result.changed).toBe(false);
    expect(mockGateway.preview).toHaveBeenCalledWith(INTENT_ID);
    expect(mockGateway.apply).not.toHaveBeenCalled();
  });

  it("previews historical orphans without offering repair", async () => {
    const mockGateway = gateway();
    const result = await executeReconciliation(
      { mode: "orphans", projectRef: PROJECT_REF },
      dependencies(mockGateway)
    );

    expect(result.changed).toBe(false);
    expect(mockGateway.previewOrphans).toHaveBeenCalledTimes(1);
    expect(mockGateway.apply).not.toHaveBeenCalled();
  });

  it("applies only through the dedicated audited RPC", async () => {
    const mockGateway = gateway();
    const result = await executeReconciliation(
      {
        mode: "apply",
        projectRef: PROJECT_REF,
        intentId: INTENT_ID,
        actorProfileId: ACTOR_ID,
        reason: "Validated exact match"
      },
      dependencies(mockGateway)
    );

    expect(result.changed).toBe(true);
    expect(mockGateway.apply).toHaveBeenCalledWith(
      INTENT_ID,
      ACTOR_ID,
      "Validated exact match"
    );
  });

  it("rejects duplicate, invalid and conflicting flags before connecting", () => {
    expect(() =>
      parseReconciliationArgs([
        `--project-ref=${PROJECT_REF}`,
        `--project-ref=${PROJECT_REF}`
      ])
    ).toThrow("DUPLICATE_FLAG");
    expect(() =>
      parseReconciliationArgs([`--project-ref=${PROJECT_REF}`, "--intent-id=invalid"])
    ).toThrow("INTENT_ID_INVALID");
    expect(() =>
      parseReconciliationArgs(["--preview", "--apply", `--project-ref=${PROJECT_REF}`])
    ).toThrow("CONFLICTING_MODE");
  });
});
