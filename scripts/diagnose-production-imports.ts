import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getUploadRuntimeDiagnostics,
  checkStorageBucket,
  checkUploadSchema
} from "../lib/upload/diagnostics";
import { getSupabasePublishableKey, getSupabaseServiceRoleKey, SECURITY_LIMITS } from "../lib/security/env";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";

type CheckResult = {
  name: string;
  status: "passed" | "failed" | "warning";
  message: string;
  details?: unknown;
};

const mode = process.argv.includes("--worker") ? "worker" : "production-imports";
const results: CheckResult[] = [];

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

function pass(name: string, message: string, details?: unknown) {
  results.push({ name, status: "passed", message, details });
}

function fail(name: string, message: string, details?: unknown) {
  results.push({ name, status: "failed", message, details });
}

function warn(name: string, message: string, details?: unknown) {
  results.push({ name, status: "warning", message, details });
}

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) return null;
  return createClient(url, key, serverSupabaseClientOptions());
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabasePublishableKey();
  if (!url || !key) return null;
  return createClient(url, key, serverSupabaseClientOptions());
}

async function checkColumns(supabase: SupabaseClient) {
  const requiredImportColumns = "id,status,locked_by,locked_at,heartbeat_at,attempts,max_attempts,next_retry_at,last_error,worker_id,cancel_requested,started_at,finished_at,upload_strategy,duration_ms";
  const requiredBatchColumns = "id,status,upload_strategy,upload_speed_bps,upload_eta_seconds,worker_last_heartbeat_at";
  const importResult = await supabase.from("import_jobs").select(requiredImportColumns).limit(1);
  const batchResult = await supabase.from("upload_batches").select(requiredBatchColumns).limit(1);
  if (importResult.error) fail("import_jobs columns", "Missing production worker columns on import_jobs.", importResult.error);
  else pass("import_jobs columns", "Required production worker columns exist.");
  if (batchResult.error) fail("upload_batches columns", "Missing production upload columns on upload_batches.", batchResult.error);
  else pass("upload_batches columns", "Required production upload columns exist.");
}

async function checkJobHealth(supabase: SupabaseClient) {
  const staleCutoff = new Date(Date.now() - SECURITY_LIMITS.workerStaleAfterMinutes * 60 * 1000).toISOString();
  const queuedCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const [queued, oldQueued, staleProcessing, recentErrors, heartbeat] = await Promise.all([
    supabase.from("import_jobs").select("id", { count: "exact", head: true }).in("status", ["queued", "retrying"]),
    supabase.from("import_jobs").select("id,created_at,original_file_name", { count: "exact" }).in("status", ["queued", "retrying"]).lt("created_at", queuedCutoff).limit(10),
    supabase.from("import_jobs").select("id,heartbeat_at,locked_by,original_file_name", { count: "exact" }).eq("status", "processing").lt("heartbeat_at", staleCutoff).limit(10),
    supabase.from("import_job_errors").select("id,job_id,error_message,created_at").gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).order("created_at", { ascending: false }).limit(10),
    supabase.from("import_jobs").select("heartbeat_at,worker_id").not("heartbeat_at", "is", null).order("heartbeat_at", { ascending: false }).limit(1).maybeSingle()
  ]);

  if (queued.error) fail("queued jobs", "Unable to inspect queued jobs.", queued.error);
  else pass("queued jobs", `${queued.count ?? 0} queued/retrying jobs found.`);

  if (oldQueued.error) fail("old queued jobs", "Unable to inspect old queued jobs.", oldQueued.error);
  else if ((oldQueued.count ?? 0) > 0) warn("old queued jobs", `${oldQueued.count} jobs have waited more than 2 minutes. Check the worker service.`, oldQueued.data);
  else pass("old queued jobs", "No queued jobs older than 2 minutes.");

  if (staleProcessing.error) fail("stale processing jobs", "Unable to inspect stale processing jobs.", staleProcessing.error);
  else if ((staleProcessing.count ?? 0) > 0) fail("stale processing jobs", `${staleProcessing.count} processing jobs have stale heartbeat.`, staleProcessing.data);
  else pass("stale processing jobs", "No stale processing jobs found.");

  if (recentErrors.error) fail("recent import errors", "Unable to inspect import_job_errors.", recentErrors.error);
  else if ((recentErrors.data ?? []).length) warn("recent import errors", `${recentErrors.data?.length ?? 0} recent import errors in the last 24h.`, recentErrors.data);
  else pass("recent import errors", "No import_job_errors in the last 24h.");

  if (heartbeat.error) warn("worker heartbeat", "Unable to read latest worker heartbeat.", heartbeat.error);
  else if (!heartbeat.data) warn("worker heartbeat", "No worker heartbeat has been recorded yet.");
  else pass("worker heartbeat", `Latest worker heartbeat: ${heartbeat.data.heartbeat_at}`, heartbeat.data);
}

async function checkTempDisk() {
  const tempDir = process.env.UPLOAD_TEMP_DIR || ".tmp/imports";
  await fs.promises.mkdir(tempDir, { recursive: true });
  const statfs = await fs.promises.statfs(tempDir).catch(() => null);
  if (!statfs) {
    warn("temp disk", `Unable to inspect temp disk at ${tempDir}.`);
    return;
  }
  const freeGb = Math.round((Number(statfs.bavail) * Number(statfs.bsize)) / 1024 / 1024 / 1024);
  if (freeGb < 20) warn("temp disk", `Only ${freeGb} GB free at ${tempDir}. Large XLSX imports may fail.`);
  else pass("temp disk", `${freeGb} GB free at ${tempDir}.`);
}

async function main() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");

  const diagnostics = getUploadRuntimeDiagnostics();
  for (const error of diagnostics.errors) fail("environment", error);
  for (const warning of diagnostics.warnings) warn("environment", warning);
  if (!diagnostics.errors.length) pass("environment", `${mode} environment has required production variables.`, diagnostics);

  const service = serviceClient();
  const anon = publicClient();
  if (!service) fail("service client", "Supabase service-role client could not be created.");
  else pass("service client", "Supabase service-role client configured.");
  if (!anon) fail("publishable client", "Supabase publishable client could not be created.");
  else pass("publishable client", "Supabase publishable client configured.");

  if (service) {
    await checkStorageBucket(service, diagnostics.storageBucket).then(
      () => pass("storage bucket", `${diagnostics.storageBucket} is accessible.`),
      (error) => fail("storage bucket", `${diagnostics.storageBucket} is not accessible.`, error)
    );
    await checkUploadSchema(service).then(
      () => pass("background schema", "Base background import schema is present."),
      (error) => fail("background schema", "Background import schema is missing or incomplete.", error)
    );
    await checkColumns(service);
    await checkJobHealth(service);
  }

  await checkTempDisk();

  const recommendations = [
    "Run Web and Worker as separate Render services.",
    "Use CSV for extremely large files whenever possible; XLSX needs temp disk and more CPU/RAM.",
    "Set Supabase Storage global and bucket file-size limits >= MAX_UPLOAD_SIZE_MB.",
    "Keep WORKER_CONCURRENCY=1 until stress tests prove the database can handle more."
  ];

  const grouped = {
    passed: results.filter((item) => item.status === "passed"),
    failed: results.filter((item) => item.status === "failed"),
    warnings: results.filter((item) => item.status === "warning"),
    recommendations
  };
  console.log(JSON.stringify(grouped, null, 2));
  if (grouped.failed.length) process.exitCode = 1;
}

main().catch((error) => {
  fail("diagnostic crash", error instanceof Error ? error.message : String(error), error);
  console.log(JSON.stringify({
    passed: results.filter((item) => item.status === "passed"),
    failed: results.filter((item) => item.status === "failed"),
    warnings: results.filter((item) => item.status === "warning"),
    recommendations: ["Fix the diagnostic crash and rerun the command."]
  }, null, 2));
  process.exitCode = 1;
});
