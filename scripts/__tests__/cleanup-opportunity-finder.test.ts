import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { runOpportunityFinderCleanupWithClient } from "../cleanup-opportunity-finder";

const OBSERVED_AT = "2026-08-08T18:00:00.000Z";
const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000002";
const FILE_ID = "00000000-0000-4000-8000-000000000003";
const FILE_TOKEN = "00000000-0000-4000-8000-000000000004";
const OTHER_ID = "00000000-0000-4000-8000-000000000005";

const validClaim = {
  file_id: FILE_ID,
  job_id: JOB_ID,
  owner_id: OWNER_ID,
  original_file_name: "source.xlsx",
  storage_bucket: "opportunity-finder",
  storage_path: `${OWNER_ID}/${JOB_ID}/${FILE_ID}.xlsx`,
  storage_deletion_token: FILE_TOKEN
};

type MockResult = { data: unknown; error: unknown };

function mockCleanupClient(input: {
  claims?: unknown[];
  expiredJobs?: Array<{ id: string; status: string }>;
  jobFiles?: Array<{
    job_id: string;
    storage_deleted_at: string | null;
    storage_deletion_token: string | null;
  }>;
  storageResults?: MockResult[];
  rpcOverrides?: Partial<Record<string, MockResult>>;
} = {}) {
  const claims = input.claims ?? [];
  const expiredJobs = input.expiredJobs ?? [];
  const jobFiles = input.jobFiles ?? [];
  const tokens = new Map(
    claims
      .filter((claim): claim is typeof validClaim => (
        Boolean(claim) && typeof claim === "object" &&
        "storage_deletion_token" in claim && "file_id" in claim
      ))
      .map((claim) => [claim.storage_deletion_token, claim.file_id])
  );
  const storageResults = [...(input.storageResults ?? [{ data: [{ name: FILE_ID }], error: null }])];
  const remove = vi.fn(async () => storageResults.shift() ?? { data: [], error: null });
  const storageFrom = vi.fn(() => ({ remove }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<MockResult> => {
    const override = input.rpcOverrides?.[name];
    if (override) return override;
    if (name === "claim_opportunity_finder_file_retention") {
      return { data: claims, error: null };
    }
    if (name === "abort_opportunity_finder_file_retention") {
      return {
        data: tokens.get(String(args.storage_deletion_token)) ?? null,
        error: null
      };
    }
    if (name === "finalize_opportunity_finder_file_retention") {
      return {
        data: tokens.get(String(args.storage_deletion_token)) ?? null,
        error: null
      };
    }
    if (name === "prepare_opportunity_finder_expired_job_deletion") {
      return {
        data: {
          id: args.job_id,
          created_by: OWNER_ID,
          status: "cancelled",
          error_code: "JOB_DELETION_REQUESTED"
        },
        error: null
      };
    }
    if (name === "finalize_opportunity_finder_job_deletion") {
      return { data: args.job_id, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });

  const jobsStatusIn = vi.fn(() => ({
    order: vi.fn(() => ({
      order: vi.fn(() => ({
        limit: vi.fn(async () => ({ data: expiredJobs, error: null }))
      }))
    }))
  }));
  const jobsSelect = vi.fn(() => ({
    lt: vi.fn(() => ({
      in: jobsStatusIn
    }))
  }));
  const filesSelect = vi.fn(() => ({
    in: vi.fn(async () => ({ data: jobFiles, error: null }))
  }));
  const from = vi.fn((table: string) => {
    if (table === "opportunity_finder_jobs") return { select: jobsSelect };
    if (table === "opportunity_finder_files") return { select: filesSelect };
    throw new Error(`Unexpected table: ${table}`);
  });
  const client = {
    rpc,
    from,
    storage: { from: storageFrom }
  } as unknown as SupabaseClient;
  return { client, rpc, from, jobsStatusIn, storageFrom, remove };
}

describe("Opportunity Finder retention cleanup", () => {
  it("never mutates or deletes an expired job observed in an active status", async () => {
    const mocks = mockCleanupClient();

    const outcome = await runOpportunityFinderCleanupWithClient(mocks.client, OBSERVED_AT);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_opportunity_finder_file_retention", {
      batch_size: 500,
      claimed_at: OBSERVED_AT
    });
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalledWith("opportunity_finder_files");
    expect(mocks.jobsStatusIn).toHaveBeenCalledWith("status", [
      "completed",
      "completed_with_warnings",
      "failed",
      "cancelled"
    ]);
    expect(outcome).toMatchObject({
      expiredFilesProcessed: 0,
      expiredJobsProcessed: 0,
      expiredJobsDeleted: 0,
      expiredJobsDeferred: 0
    });
  });

  it("finalizes one canonical Storage deletion and one expired terminal job through fenced RPCs", async () => {
    const mocks = mockCleanupClient({
      claims: [validClaim],
      expiredJobs: [{ id: JOB_ID, status: "completed" }],
      jobFiles: [{
        job_id: JOB_ID,
        storage_deleted_at: OBSERVED_AT,
        storage_deletion_token: null
      }]
    });

    const outcome = await runOpportunityFinderCleanupWithClient(mocks.client, OBSERVED_AT);

    expect(mocks.storageFrom).toHaveBeenCalledWith("opportunity-finder");
    expect(mocks.remove).toHaveBeenCalledWith([validClaim.storage_path]);
    expect(mocks.rpc.mock.calls).toEqual([
      ["claim_opportunity_finder_file_retention", {
        batch_size: 500,
        claimed_at: OBSERVED_AT
      }],
      ["finalize_opportunity_finder_file_retention", {
        storage_deletion_token: FILE_TOKEN,
        deleted_at: OBSERVED_AT
      }],
      ["prepare_opportunity_finder_expired_job_deletion", {
        job_id: JOB_ID,
        expected_status: "completed",
        observed_at: OBSERVED_AT
      }],
      ["finalize_opportunity_finder_job_deletion", {
        job_id: JOB_ID,
        actor_id: OWNER_ID
      }]
    ]);
    expect(outcome).toEqual({
      expiredFilesProcessed: 1,
      expiredFilesDeleted: 1,
      storageDeleteFailures: 0,
      invalidStorageReferences: 0,
      unexpectedStorageResponses: 0,
      expiredJobsProcessed: 1,
      expiredJobsDeleted: 1,
      expiredJobsDeferred: 0
    });
  });

  it("audits and releases claims for invalid references and Storage failures", async () => {
    const invalidClaim = { ...validClaim, storage_path: "someone-else/private.xlsx" };
    const secondClaim = {
      ...validClaim,
      file_id: OTHER_ID,
      storage_path: `${OWNER_ID}/${JOB_ID}/${OTHER_ID}.xlsx`,
      storage_deletion_token: "00000000-0000-4000-8000-000000000006"
    };
    const mocks = mockCleanupClient({
      claims: [invalidClaim, secondClaim],
      storageResults: [{ data: null, error: { message: "storage unavailable" } }]
    });

    const outcome = await runOpportunityFinderCleanupWithClient(mocks.client, OBSERVED_AT);

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("abort_opportunity_finder_file_retention", {
      storage_deletion_token: FILE_TOKEN,
      failure_code: "INVALID_STORAGE_REFERENCE"
    });
    expect(mocks.rpc).toHaveBeenCalledWith("abort_opportunity_finder_file_retention", {
      storage_deletion_token: secondClaim.storage_deletion_token,
      failure_code: "STORAGE_DELETE_FAILED"
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "finalize_opportunity_finder_file_retention",
      expect.anything()
    );
    expect(outcome).toMatchObject({
      expiredFilesProcessed: 2,
      expiredFilesDeleted: 0,
      invalidStorageReferences: 1,
      storageDeleteFailures: 1
    });
  });

  it("finalizes an idempotent reclaimed deletion when Storage reports an absent object", async () => {
    const reclaimed = mockCleanupClient({
      claims: [validClaim],
      storageResults: [{ data: [], error: null }]
    });
    const outcome = await runOpportunityFinderCleanupWithClient(reclaimed.client, OBSERVED_AT);
    expect(reclaimed.rpc).toHaveBeenCalledWith("finalize_opportunity_finder_file_retention", {
      storage_deletion_token: FILE_TOKEN,
      deleted_at: OBSERVED_AT
    });
    expect(reclaimed.rpc).not.toHaveBeenCalledWith(
      "abort_opportunity_finder_file_retention",
      expect.anything()
    );
    expect(outcome.expiredFilesDeleted).toBe(1);

    const unexpected = mockCleanupClient({
      claims: [validClaim],
      storageResults: [{ data: null, error: null }]
    });
    const unexpectedOutcome = await runOpportunityFinderCleanupWithClient(
      unexpected.client,
      OBSERVED_AT
    );
    expect(unexpected.rpc).toHaveBeenCalledWith("abort_opportunity_finder_file_retention", {
      storage_deletion_token: FILE_TOKEN,
      failure_code: "UNEXPECTED_STORAGE_RESPONSE"
    });
    expect(unexpectedOutcome.unexpectedStorageResponses).toBe(1);
  });

  it("verifies the affected ID returned by file finalize", async () => {

    const wrongFinalize = mockCleanupClient({
      claims: [validClaim],
      rpcOverrides: {
        finalize_opportunity_finder_file_retention: { data: OTHER_ID, error: null }
      }
    });
    await expect(runOpportunityFinderCleanupWithClient(wrongFinalize.client, OBSERVED_AT))
      .rejects.toThrow("OPPORTUNITY_FILE_RETENTION_FINALIZE_ID_MISMATCH");
  });

  it("uses deterministic expiry and ID ordering before applying the batch limit", async () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/cleanup-opportunity-finder.ts"),
      "utf8"
    );
    const expiryOrder = source.indexOf('.order("expires_at", { ascending: true })');
    const statusFilter = source.indexOf('.in("status", Array.from(RETENTION_TERMINAL_STATUSES))');
    const idOrder = source.indexOf('.order("id", { ascending: true })', expiryOrder);
    const limit = source.indexOf(".limit(RETENTION_BATCH_SIZE)", idOrder);
    expect(statusFilter).toBeGreaterThan(-1);
    expect(expiryOrder).toBeGreaterThan(statusFilter);
    expect(expiryOrder).toBeGreaterThan(-1);
    expect(idOrder).toBeGreaterThan(expiryOrder);
    expect(limit).toBeGreaterThan(idOrder);
  });

  it("defers a job when the expiry/status CAS loses a race and never finalizes it", async () => {
    const mocks = mockCleanupClient({
      expiredJobs: [{ id: JOB_ID, status: "failed" }],
      jobFiles: [],
      rpcOverrides: {
        prepare_opportunity_finder_expired_job_deletion: {
          data: null,
          error: { code: "40001", message: "status changed" }
        }
      }
    });

    const outcome = await runOpportunityFinderCleanupWithClient(mocks.client, OBSERVED_AT);

    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "finalize_opportunity_finder_job_deletion",
      expect.anything()
    );
    expect(outcome).toMatchObject({ expiredJobsDeleted: 0, expiredJobsDeferred: 1 });
  });

  it("treats a concurrent finalize that already deleted the job as a successful race", async () => {
    const mocks = mockCleanupClient({
      expiredJobs: [{ id: JOB_ID, status: "cancelled" }],
      jobFiles: [],
      rpcOverrides: {
        finalize_opportunity_finder_job_deletion: {
          data: null,
          error: { code: "P0002", message: "job already deleted" }
        }
      }
    });

    const outcome = await runOpportunityFinderCleanupWithClient(mocks.client, OBSERVED_AT);

    expect(mocks.rpc).toHaveBeenCalledWith("prepare_opportunity_finder_expired_job_deletion", {
      job_id: JOB_ID,
      expected_status: "cancelled",
      observed_at: OBSERVED_AT
    });
    expect(mocks.rpc).toHaveBeenCalledWith("finalize_opportunity_finder_job_deletion", {
      job_id: JOB_ID,
      actor_id: OWNER_ID
    });
    expect(outcome).toMatchObject({ expiredJobsDeleted: 0, expiredJobsDeferred: 1 });
  });

  it("keeps deletion audits durable and free of source metadata at the SQL boundary", () => {
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/20260808120000_opportunity_finder_advanced.sql"),
      "utf8"
    );
    const fileFinalize = migration.slice(
      migration.indexOf("create or replace function public.finalize_opportunity_finder_file_retention"),
      migration.indexOf("create or replace function public.abort_opportunity_finder_file_retention")
    );
    expect(fileFinalize).toContain("'source_file_deleted'");
    expect(fileFinalize).toContain("jsonb_build_object('retention', true)");
    expect(fileFinalize.indexOf("'source_file_deleted'"))
      .toBeLessThan(fileFinalize.indexOf("return locked_file.id"));
    expect(fileFinalize).not.toContain("jsonb_build_object('storagePath'");
    expect(fileFinalize).not.toContain("jsonb_build_object('originalFileName'");

    const jobFinalize = migration.slice(
      migration.indexOf("create or replace function public.finalize_opportunity_finder_job_deletion"),
      migration.indexOf("create or replace function public.claim_opportunity_finder_file_retention")
    );
    expect(jobFinalize).toContain("'job_deleted'");
    expect(jobFinalize.indexOf("'job_deleted'"))
      .toBeLessThan(jobFinalize.indexOf("delete from public.opportunity_finder_jobs"));
    expect(migration).toContain("references public.opportunity_finder_jobs(id) on delete set null");
  });
});
