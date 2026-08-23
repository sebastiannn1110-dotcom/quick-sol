import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const migration = source("supabase/migrations/20260823120000_harden_import_job_pipeline.sql");
const worker = source("lib/upload/import-worker.ts");

describe("Ronda 4 trusted import pipeline", () => {
  it("removes authenticated lifecycle DML and exposes only backend RPC mutations", () => {
    expect(migration).toContain("revoke insert, update, delete on public.import_jobs from authenticated");
    expect(migration).toContain("revoke insert, update, delete on public.upload_batches from authenticated");
    expect(migration).toContain("drop policy if exists import_jobs_insert_own");
    expect(migration).toContain("drop policy if exists import_jobs_update_owner_or_admin");
    expect(migration).toMatch(/revoke all on function public\.create_import_upload_v2[\s\S]*?from public,anon,authenticated/);
    expect(migration).toContain("grant execute on function public.create_import_upload_v2");
    expect(migration).toContain("to service_role");
  });

  it("issues provenance server-side and validates Storage identity before queueing", () => {
    expect(migration).toContain("'trusted_upload_api'");
    expect(migration).toContain("storage_path_value := format('%s/%s/%s'");
    expect(migration).toContain("object_row.id is null");
    expect(migration).toContain("job.storage_path<>batch.stored_file_path");
    expect(migration).toContain("job.expected_size_bytes<>batch.file_size");
    expect(migration).toContain("provenance_status='verified'");
  });

  it("uses exclusive claim, lease renewal, generation and a monotonic fencing token", () => {
    expect(migration).toContain("for update of job skip locked limit 1");
    expect(migration).toContain("lease_token=lease_token+1");
    expect(migration).toContain("lease_expires_at>clock_timestamp()");
    expect(migration).toContain("job.generation<>input_generation");
    expect(migration).toContain("job.lease_token<>input_lease_token");
    expect(migration).toContain("IMPORT_WORKER_FENCED");
    expect(migration).toContain("IMPORT_JOB_SUPERSEDED");
  });

  it("stages and validates all rows before the transactional replacement", () => {
    const validation = migration.indexOf("create or replace function public.validate_import_job_staging_v2");
    const publication = migration.indexOf("create or replace function public.publish_import_job_v2");
    const replacement = migration.indexOf("delete from public.business_records", publication);
    const insertion = migration.indexOf("insert into public.business_records", replacement);
    expect(validation).toBeGreaterThan(0);
    expect(publication).toBeGreaterThan(validation);
    expect(replacement).toBeGreaterThan(publication);
    expect(insertion).toBeGreaterThan(replacement);
    expect(migration).toContain("IMPORT_PUBLISH_INJECTED_FAILURE");
  });

  it("prevents the worker from falling back to direct privileged table mutations", () => {
    expect(worker).toContain('rpc("claim_import_job_v2"');
    expect(worker).toContain('rpc("stage_import_job_rows_v2"');
    expect(worker).toContain('rpc("validate_import_job_staging_v2"');
    expect(worker).toContain('rpc("publish_import_job_v2"');
    expect(worker).toContain('rpc("fail_import_job_v2"');
    expect(worker).not.toMatch(/\.from\("(?:business_records|upload_sheets|import_errors|import_job_errors|import_job_error_summary|import_jobs|upload_batches)"\)\.(?:insert|update|delete)/);
    expect(worker).not.toContain('rpc("claim_import_job"');
    expect(worker).not.toContain("finalizeImportJobSafely");
    expect(worker).not.toContain("rebuildBusinessUploadSummary");
  });

  it("computes size and SHA-256 while streaming without logging locators or rows", () => {
    expect(worker).toContain('createHash("sha256")');
    expect(worker).toContain("Readable.fromWeb(webStream), verifier");
    expect(worker).toContain("IMPORT_FILE_SIZE_MISMATCH");
    expect(worker).toContain("IMPORT_FILE_HASH_MISMATCH");
    expect(worker).not.toMatch(/metadata:\s*\{[^}]*signedUrl/);
    expect(worker).not.toMatch(/metadata:\s*\{[^}]*storagePath/);
    expect(worker).not.toMatch(/metadata:\s*\{[^}]*raw_data/);
  });

  it("routes all browser lifecycle requests through service-role RPCs", () => {
    const routes = [
      "app/api/upload/initiate/route.ts",
      "app/api/upload/finalize/route.ts",
      "app/api/upload/jobs/[id]/retry/route.ts",
      "app/api/upload/jobs/[id]/cancel/route.ts",
      "app/api/admin/imports/jobs/[id]/retry/route.ts",
      "app/api/admin/imports/jobs/[id]/cancel/route.ts",
      "app/api/superadmin/jobs/[id]/retry/route.ts",
      "app/api/superadmin/jobs/[id]/cancel/route.ts"
    ].map(source).join("\n");
    expect(routes).toContain('rpc("create_import_upload_v2"');
    expect(routes).toContain('rpc("finalize_import_upload_v2"');
    expect(routes).toContain('rpc("request_import_job_retry_v2"');
    expect(routes).toContain('rpc("request_import_job_cancel_v2"');
    expect(routes).not.toMatch(/\.from\("import_jobs"\)\.(?:insert|update|delete)/);
    expect(routes).not.toMatch(/\.from\("upload_batches"\)\.(?:insert|update|delete)/);
  });

  it("supervises a real import worker heartbeat instead of inferring health from jobs", () => {
    const supervisor = source("scripts/start-production.mjs");
    const entrypoint = source("scripts/import-worker.ts");
    const metrics = source("lib/superadmin/metrics.ts");
    expect(supervisor).toContain('name: "import-worker"');
    expect(supervisor).toContain('"scripts/import-worker.ts"');
    expect(entrypoint).toContain('rpc("record_worker_runtime_heartbeat_v2"');
    expect(metrics).toContain('from("worker_runtime_heartbeats")');
    expect(metrics).not.toContain('select("heartbeat_at,worker_id,original_file_name")');
  });
});
