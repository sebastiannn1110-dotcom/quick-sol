import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  isBusinessSummaryFencedError,
  isRetryableBusinessSummaryError,
  rebuildBusinessUploadSummary,
  safeBusinessSummaryErrorCode,
  type BusinessSummaryRebuildClaim
} from "@/lib/performance/business-summaries";
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
const leaseSeconds = Math.min(
  Math.max(Math.floor(Number(process.env.BUSINESS_SUMMARY_LEASE_SECONDS) || 120), 30),
  900
);
const sourceChunkSize = Math.min(
  Math.max(Math.floor(Number(process.env.BUSINESS_SUMMARY_CHUNK_SIZE) || 500), 1),
  500
);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function main() {
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new Error("Missing Supabase service role key.");
  const supabase = createClient(getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL"), key, serverSupabaseClientOptions());

  while (!stopping) {
    const claim = await supabase.rpc("claim_business_summary_rebuild_v2", {
      input_worker_id: workerId,
      input_lease_seconds: leaseSeconds
    });
    if (claim.error) throw claim.error;
    const job = ((claim.data ?? []) as unknown as BusinessSummaryRebuildClaim[])[0] ?? null;
    if (job) {
      try {
        await rebuildBusinessUploadSummary(supabase, job, workerId, {
          chunkSize: sourceChunkSize,
          leaseSeconds
        });
      } catch (error) {
        // A stale worker must never mutate the generation that reclaimed it.
        if (!isBusinessSummaryFencedError(error)) {
          const failed = await supabase.rpc("fail_business_summary_rebuild_v2", {
            input_upload_batch_id: job.upload_batch_id,
            input_worker_id: workerId,
            input_rebuild_id: job.rebuild_id,
            input_generation: job.rebuild_generation,
            input_fence_token: job.fence_token,
            input_error_code: safeBusinessSummaryErrorCode(error),
            input_retryable: isRetryableBusinessSummaryError(error)
          });
          if (failed.error && !isBusinessSummaryFencedError(failed.error)) throw failed.error;
        }
      }
    }
    if (once) break;
    if (!job) await wait(intervalMs);
  }
}

main().catch(() => {
  console.error("Business summary worker failed. Inspect the persisted safe rebuild error code.");
  process.exit(1);
});
