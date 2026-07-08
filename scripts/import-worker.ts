import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger/logger";
import { getRequiredServerEnv, getSupabaseServiceRoleKey, SECURITY_LIMITS } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import { claimNextImportJob, processImportJob, recoverStaleImportJobs } from "@/lib/upload/import-worker";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFile(fileName: string) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const runOnce = process.argv.includes("--once");
const workerId = `${os.hostname()}-${process.pid}`;
let shuttingDown = false;

process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

async function runWorkerSlot(supabase: SupabaseClient) {
  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "job_claim_started",
    message: "Worker is attempting to claim an import job.",
    status: "started",
    metadata: { workerId }
  });
  const job = await claimNextImportJob(supabase, workerId);
  if (!job) return false;
  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "job_claim_completed",
    message: "Worker claimed an import job.",
    status: "completed",
    uploadBatchId: job.upload_batch_id,
    fileName: job.original_file_name,
    metadata: { workerId, jobId: job.id, attempts: job.attempts, maxAttempts: job.max_attempts }
  });

  try {
    await processImportJob(supabase, job, workerId);
  } catch (error) {
    await logger.error({
      traceId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      route: "import-worker",
      method: "WORKER",
      module: "upload",
      action: "worker_job_failed",
      message: "Import worker job failed.",
      status: "failed",
      uploadBatchId: job.upload_batch_id,
      fileName: job.original_file_name,
      metadata: { jobId: job.id, workerId },
      error
    });
  }

  return true;
}

async function main() {
  const supabaseUrl = getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY for import worker.");

  const supabase = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "worker_env_loaded",
    message: "Import worker environment loaded.",
    status: "completed",
    metadata: {
      workerId,
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasServiceRoleKey: Boolean(serviceRoleKey),
      maxUploadSizeMb: Math.round(SECURITY_LIMITS.maxUploadSizeBytes / 1024 / 1024),
      maxRowsPerFile: SECURITY_LIMITS.maxExcelRows,
      maxExcelSheets: SECURITY_LIMITS.maxExcelSheets,
      importBatchSize: SECURITY_LIMITS.importBatchSize,
      insertChunkSize: SECURITY_LIMITS.uploadChunkSize,
      staleAfterMinutes: SECURITY_LIMITS.workerStaleAfterMinutes,
      heartbeatIntervalMs: SECURITY_LIMITS.workerHeartbeatIntervalMs
    }
  });
  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "worker_started",
    message: "Import worker started.",
    status: "started",
    metadata: {
      workerId,
      concurrency: SECURITY_LIMITS.workerConcurrency,
      pollIntervalMs: SECURITY_LIMITS.workerPollIntervalMs
    }
  });

  while (!shuttingDown) {
    try {
      await logger.info({
        traceId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        route: "import-worker",
        method: "WORKER",
        module: "upload",
        action: "worker_poll_started",
        message: "Worker poll started.",
        status: "started",
        metadata: { workerId }
      });
      await recoverStaleImportJobs(supabase, workerId);
      const { count: queuedCount } = await supabase
        .from("import_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "retrying"]);
      await logger.info({
        traceId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        route: "import-worker",
        method: "WORKER",
        module: "upload",
        action: "queued_jobs_found",
        message: "Worker checked queued import jobs.",
        status: "completed",
        metadata: { workerId, queuedJobs: queuedCount ?? 0 }
      });
      const slots = Array.from({ length: SECURITY_LIMITS.workerConcurrency }, () => runWorkerSlot(supabase));
      const results = await Promise.all(slots);
      if (runOnce) break;
      if (!results.some(Boolean)) await sleep(SECURITY_LIMITS.workerPollIntervalMs);
    } catch (error) {
      await logger.error({
        traceId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        route: "import-worker",
        method: "WORKER",
        module: "upload",
        action: "worker_loop_failed",
        message: "Import worker loop failed; retrying after poll interval.",
        status: "failed",
        metadata: { workerId },
        error
      });
      if (runOnce) break;
      await sleep(SECURITY_LIMITS.workerPollIntervalMs);
    }
  }

  await logger.info({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: "import-worker",
    method: "WORKER",
    module: "upload",
    action: "worker_stopped",
    message: "Import worker stopped.",
    status: "completed",
    metadata: { workerId }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
