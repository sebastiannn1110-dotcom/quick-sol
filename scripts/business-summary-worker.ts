import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { rebuildBusinessUploadSummary } from "@/lib/performance/business-summaries";
import { getRequiredServerEnv, getSupabaseServiceRoleKey } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ??= value;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const once = process.argv.includes("--once");
const workerId = `summary-${os.hostname()}-${process.pid}`;
const intervalMs = Math.max(Number(process.env.BUSINESS_SUMMARY_POLL_INTERVAL_MS) || 5000, 1000);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new Error("Missing Supabase service role key.");
  const supabase = createClient(getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL"), key, serverSupabaseClientOptions());

  while (!stopping) {
    const claim = await supabase.rpc("claim_business_summary_rebuilds_v1", { worker_id: workerId, batch_limit: 4 });
    if (claim.error) throw claim.error;
    const jobs = (claim.data ?? []) as Array<{ upload_batch_id: string }>;
    for (const job of jobs) {
      try {
        await rebuildBusinessUploadSummary(supabase, job.upload_batch_id);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "rebuild_failed";
        await supabase.rpc("release_business_summary_rebuild_v1", {
          target_upload_batch_id: job.upload_batch_id,
          worker_id: workerId,
          error_code: code
        });
      }
    }
    if (once) break;
    if (!jobs.length) await wait(intervalMs);
  }
}

main().catch(() => {
  console.error("Business summary worker failed. Inspect the persisted safe rebuild error code.");
  process.exit(1);
});
