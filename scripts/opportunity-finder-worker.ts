import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  claimNextOpportunityFinderJob,
  processOpportunityFinderJob
} from "@/lib/opportunity-finder/worker";
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
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const once = process.argv.includes("--once");
const workerId = `opportunity-${os.hostname()}-${process.pid}`;
const pollIntervalMs = Number(process.env.OPPORTUNITY_WORKER_POLL_INTERVAL_MS) || 5000;
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  const supabaseUrl = getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!serviceRoleKey) throw new Error("Missing Supabase service role key.");
  const supabase = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());

  while (!stopping) {
    const job = await claimNextOpportunityFinderJob(supabase, workerId);
    if (job) {
      try {
        await processOpportunityFinderJob(supabase, job, workerId);
      } catch {
        // The worker already persisted a safe error code and retry state.
      }
    }
    if (once) break;
    if (!job) await wait(pollIntervalMs);
  }
}

main().catch(() => {
  console.error("Opportunity Finder worker failed. See the persisted safe job error code.");
  process.exit(1);
});
