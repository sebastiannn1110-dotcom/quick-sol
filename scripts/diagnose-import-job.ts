import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import { getImportJobDiagnostics } from "../lib/upload/job-diagnostics";

function loadEnv() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index);
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
}

function arg(name: string) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnv();
  const jobId = arg("jobId") ?? arg("job-id");
  if (!jobId) throw new Error("Usage: npm run diagnose:job -- --jobId=<import_job_id>");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

  const supabase = createClient(url, key, serverSupabaseClientOptions());
  const diagnostics = await getImportJobDiagnostics(supabase, jobId);
  if (!diagnostics) throw new Error(`Import job not found: ${jobId}`);

  console.log(JSON.stringify({
    jobId,
    status: diagnostics.job.status,
    attempts: diagnostics.job.attempts,
    maxAttempts: diagnostics.job.max_attempts,
    lastError: diagnostics.job.last_error,
    errorMessage: diagnostics.job.error_message ?? diagnostics.upload?.error_message ?? null,
    heartbeatAt: diagnostics.job.heartbeat_at ?? diagnostics.upload?.worker_last_heartbeat_at ?? null,
    lockedBy: diagnostics.job.locked_by ?? null,
    lockedAt: diagnostics.job.locked_at ?? null,
    nextRetryAt: diagnostics.job.next_retry_at,
    counts: diagnostics.counts,
    groupedWarningSamples: diagnostics.groupedWarningSamples,
    safeFinalize: diagnostics.safeFinalize,
    recommendedAction: diagnostics.safeFinalize.recommendedAction
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
