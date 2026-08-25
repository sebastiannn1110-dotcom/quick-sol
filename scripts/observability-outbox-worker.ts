import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getRequiredServerEnv, getSupabaseServiceRoleKey } from "@/lib/security/env";
import { serverSupabaseClientOptions } from "@/lib/supabase/node-client-options";

for (const name of [".env.local", ".env"]) {
  const file = path.resolve(process.cwd(), name);
  if (!fs.existsSync(file)) continue;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const split = raw.indexOf("=");
    if (split < 1 || raw.trim().startsWith("#")) continue;
    const key = raw.slice(0, split).trim();
    const value = raw.slice(split + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] ??= value;
  }
}

const once = process.argv.includes("--once");
const workerId = `observability-${os.hostname()}-${process.pid}`;
let stop = false;
process.on("SIGINT", () => { stop = true; });
process.on("SIGTERM", () => { stop = true; });

async function main() {
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new Error("Missing service role key.");
  const service = createClient(getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL"), key, serverSupabaseClientOptions());
  while (!stop) {
    const claim = await service.rpc("claim_observability_log_outbox_v1", { worker_id: workerId, batch_limit: 100 });
    if (claim.error) throw claim.error;
    const events = (claim.data ?? []) as Array<{ id: string; payload: Record<string, unknown> }>;
    for (const event of events) {
      const inserted = await service.from("system_logs").insert(event.payload);
      if (!inserted.error) {
        await service.rpc("complete_observability_log_outbox_v1", { event_id: event.id, worker_id: workerId });
      } else {
        await service.rpc("fail_observability_log_outbox_v1", { event_id: event.id, worker_id: workerId, error_code: inserted.error.code ?? "insert_failed" });
      }
    }
    if (once) break;
    if (!events.length) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

main().catch(() => {
  console.error("Observability outbox worker failed; events remain durable for retry.");
  process.exit(1);
});
