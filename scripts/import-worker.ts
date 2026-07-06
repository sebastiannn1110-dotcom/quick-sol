import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger/logger";
import { getRequiredServerEnv, getSupabaseServiceRoleKey, SECURITY_LIMITS } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";
import { claimNextImportJob, processImportJob } from "@/lib/upload/import-worker";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const job = await claimNextImportJob(supabase, workerId);
  if (!job) return false;

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
