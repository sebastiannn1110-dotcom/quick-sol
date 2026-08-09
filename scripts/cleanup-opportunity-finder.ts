import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequiredServerEnv, getSupabaseServiceRoleKey } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import { assertCanonicalOpportunityStorageReference } from "@/lib/opportunity-finder/validation";

function loadEnvFile(fileName: string) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const LOOP_ARGUMENT = "--loop";
const RETENTION_BATCH_SIZE = 500;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const RETENTION_TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled"
]);

type FileRetentionClaim = {
  file_id: string;
  job_id: string;
  owner_id: string;
  original_file_name: string;
  storage_bucket: string;
  storage_path: string;
  storage_deletion_token: string;
};

type ExpiredJob = {
  id: string;
  status: string;
};

type CleanupOutcome = {
  expiredFilesProcessed: number;
  expiredFilesDeleted: number;
  storageDeleteFailures: number;
  invalidStorageReferences: number;
  unexpectedStorageResponses: number;
  expiredJobsProcessed: number;
  expiredJobsDeleted: number;
  expiredJobsDeferred: number;
};

function cleanupIntervalMs() {
  const configured = Number(process.env.OPPORTUNITY_FINDER_CLEANUP_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= MIN_CLEANUP_INTERVAL_MS
    ? configured
    : DEFAULT_CLEANUP_INTERVAL_MS;
}

function singleRpcValue(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  return data.length === 1 ? data[0] : undefined;
}

function rpcUuid(data: unknown, operation: string) {
  const value = singleRpcValue(data);
  if (typeof value !== "string" || !value) {
    throw new Error(`${operation}_AFFECTED_ROW_MISMATCH`);
  }
  return value;
}

function rpcRecord(data: unknown, operation: string) {
  const value = singleRpcValue(data);
  if (!value || typeof value !== "object") {
    throw new Error(`${operation}_AFFECTED_ROW_MISMATCH`);
  }
  return value as Record<string, unknown>;
}

function rpcErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String(error.code ?? "");
}

function isExpectedRetentionConflict(error: unknown) {
  return ["P0002", "40001", "55000"].includes(rpcErrorCode(error));
}

function isFileRetentionClaim(value: unknown): value is FileRetentionClaim {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return [
    "file_id",
    "job_id",
    "owner_id",
    "original_file_name",
    "storage_bucket",
    "storage_path",
    "storage_deletion_token"
  ].every((key) => typeof row[key] === "string" && row[key] !== "");
}

async function abortFileRetention(
  supabase: SupabaseClient,
  claim: FileRetentionClaim,
  failureCode: "STORAGE_DELETE_FAILED" | "INVALID_STORAGE_REFERENCE" | "UNEXPECTED_STORAGE_RESPONSE"
) {
  const { data, error } = await supabase.rpc("abort_opportunity_finder_file_retention", {
    storage_deletion_token: claim.storage_deletion_token,
    failure_code: failureCode
  });
  if (error) throw error;
  if (rpcUuid(data, "OPPORTUNITY_FILE_RETENTION_ABORT") !== claim.file_id) {
    throw new Error("OPPORTUNITY_FILE_RETENTION_ABORT_ID_MISMATCH");
  }
}

export async function runOpportunityFinderCleanupWithClient(
  supabase: SupabaseClient,
  observedAt = new Date().toISOString()
): Promise<CleanupOutcome> {
  const { data: claimedFiles, error: claimError } = await supabase.rpc(
    "claim_opportunity_finder_file_retention",
    { batch_size: RETENTION_BATCH_SIZE, claimed_at: observedAt }
  );
  if (claimError) throw claimError;
  if (!Array.isArray(claimedFiles)) {
    throw new Error("OPPORTUNITY_FILE_RETENTION_CLAIM_RESPONSE_INVALID");
  }

  let expiredFilesDeleted = 0;
  let storageDeleteFailures = 0;
  let invalidStorageReferences = 0;
  let unexpectedStorageResponses = 0;
  for (const rawClaim of claimedFiles) {
    if (!isFileRetentionClaim(rawClaim)) {
      throw new Error("OPPORTUNITY_FILE_RETENTION_CLAIM_ROW_INVALID");
    }
    const claim = rawClaim;
    try {
      assertCanonicalOpportunityStorageReference({
        ownerId: claim.owner_id,
        jobId: claim.job_id,
        fileId: claim.file_id,
        originalFileName: claim.original_file_name,
        storageBucket: claim.storage_bucket,
        storagePath: claim.storage_path
      });
    } catch {
      await abortFileRetention(supabase, claim, "INVALID_STORAGE_REFERENCE");
      invalidStorageReferences += 1;
      continue;
    }

    const { data: removedObjects, error: storageError } = await supabase.storage
      .from(claim.storage_bucket)
      .remove([claim.storage_path]);
    if (storageError) {
      await abortFileRetention(supabase, claim, "STORAGE_DELETE_FAILED");
      storageDeleteFailures += 1;
      continue;
    }
    // Storage DELETE is idempotent. After a process crash, a reclaimed claim can
    // legitimately receive [] because the previous process removed the object
    // but did not reach the database finalize RPC.
    if (!Array.isArray(removedObjects)) {
      await abortFileRetention(supabase, claim, "UNEXPECTED_STORAGE_RESPONSE");
      unexpectedStorageResponses += 1;
      continue;
    }

    const { data: finalizedFile, error: finalizeError } = await supabase.rpc(
      "finalize_opportunity_finder_file_retention",
      { storage_deletion_token: claim.storage_deletion_token, deleted_at: observedAt }
    );
    if (finalizeError) throw finalizeError;
    if (rpcUuid(finalizedFile, "OPPORTUNITY_FILE_RETENTION_FINALIZE") !== claim.file_id) {
      throw new Error("OPPORTUNITY_FILE_RETENTION_FINALIZE_ID_MISMATCH");
    }
    expiredFilesDeleted += 1;
  }

  const { data: expiredJobs, error: jobError } = await supabase
    .from("opportunity_finder_jobs")
    .select("id,status")
    .lt("expires_at", observedAt)
    .in("status", Array.from(RETENTION_TERMINAL_STATUSES))
    .order("expires_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(RETENTION_BATCH_SIZE);
  if (jobError) throw jobError;
  if (!Array.isArray(expiredJobs)) {
    throw new Error("OPPORTUNITY_EXPIRED_JOB_RESPONSE_INVALID");
  }

  const jobRows = expiredJobs as ExpiredJob[];
  const terminalJobs = jobRows.filter((job) => RETENTION_TERMINAL_STATUSES.has(job.status));
  const terminalJobIds = terminalJobs.map((job) => job.id);
  const jobsWithLiveObjects = new Set<string>();
  if (terminalJobIds.length) {
    const { data: jobFiles, error: jobFilesError } = await supabase
      .from("opportunity_finder_files")
      .select("job_id,storage_deleted_at,storage_deletion_token")
      .in("job_id", terminalJobIds);
    if (jobFilesError) throw jobFilesError;
    if (!Array.isArray(jobFiles)) {
      throw new Error("OPPORTUNITY_JOB_FILE_RESPONSE_INVALID");
    }
    for (const file of jobFiles) {
      if (file.storage_deleted_at === null || file.storage_deletion_token !== null) {
        jobsWithLiveObjects.add(String(file.job_id));
      }
    }
  }

  let expiredJobsDeleted = 0;
  for (const job of terminalJobs) {
    if (jobsWithLiveObjects.has(job.id)) continue;

    const { data: preparedJobData, error: prepareError } = await supabase.rpc(
      "prepare_opportunity_finder_expired_job_deletion",
      { job_id: job.id, expected_status: job.status, observed_at: observedAt }
    );
    if (prepareError) {
      if (isExpectedRetentionConflict(prepareError)) continue;
      throw prepareError;
    }
    const preparedJob = rpcRecord(
      preparedJobData,
      "OPPORTUNITY_EXPIRED_JOB_DELETION_PREPARE"
    );
    if (
      preparedJob.id !== job.id ||
      preparedJob.status !== "cancelled" ||
      preparedJob.error_code !== "JOB_DELETION_REQUESTED" ||
      typeof preparedJob.created_by !== "string" ||
      !preparedJob.created_by
    ) {
      throw new Error("OPPORTUNITY_EXPIRED_JOB_DELETION_PREPARE_ROW_MISMATCH");
    }

    const { data: finalizedJob, error: finalizeJobError } = await supabase.rpc(
      "finalize_opportunity_finder_job_deletion",
      { job_id: job.id, actor_id: preparedJob.created_by }
    );
    if (finalizeJobError) {
      if (isExpectedRetentionConflict(finalizeJobError)) continue;
      throw finalizeJobError;
    }
    if (rpcUuid(finalizedJob, "OPPORTUNITY_EXPIRED_JOB_DELETION_FINALIZE") !== job.id) {
      throw new Error("OPPORTUNITY_EXPIRED_JOB_DELETION_FINALIZE_ID_MISMATCH");
    }
    expiredJobsDeleted += 1;
  }

  return {
    expiredFilesProcessed: claimedFiles.length,
    expiredFilesDeleted,
    storageDeleteFailures,
    invalidStorageReferences,
    unexpectedStorageResponses,
    expiredJobsProcessed: jobRows.length,
    expiredJobsDeleted,
    expiredJobsDeferred: jobRows.length - expiredJobsDeleted
  };
}

export async function runOpportunityFinderCleanup() {
  const url = getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new Error("Missing Supabase service role key.");
  const supabase = createClient(url, key, serverSupabaseClientOptions());
  const outcome = await runOpportunityFinderCleanupWithClient(supabase);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome;
}

async function main() {
  const continuous = process.argv.includes(LOOP_ARGUMENT);
  do {
    try {
      await runOpportunityFinderCleanup();
    } catch {
      console.error("Opportunity Finder cleanup cycle failed.");
      if (!continuous) throw new Error("OPPORTUNITY_FINDER_CLEANUP_FAILED");
    }
    if (continuous) {
      await new Promise<void>((resolve) => setTimeout(resolve, cleanupIntervalMs()));
    }
  } while (continuous);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
