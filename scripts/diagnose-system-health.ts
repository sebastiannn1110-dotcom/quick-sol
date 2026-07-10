import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import { getSupabaseServiceRoleKey } from "../lib/security/env";
import { superadminConfigStatus } from "../lib/superadmin/auth";
import { buildSuperadminHealth, buildSuperadminSecurity } from "../lib/superadmin/metrics";
import { buildTrafficAnalytics } from "../lib/traffic/analytics";

type Status = "passed" | "failed" | "warning";
type Result = { name: string; status: Status; message: string; details?: unknown };

const mode = process.argv[2] || "system-health";
const results: Result[] = [];

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
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ??= value;
  }
}

function push(status: Status, name: string, message: string, details?: unknown) {
  results.push({ status, name, message, details });
}

async function main() {
  loadEnvFile(".env.local");
  loadEnvFile(".env");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) {
    push("failed", "environment", "Missing NEXT_PUBLIC_SUPABASE_URL or service role key.");
    print();
    process.exitCode = 1;
    return;
  }
  const service = createClient(url, key, serverSupabaseClientOptions());
  push("passed", "environment", `${mode} environment loaded.`);

  if (mode === "superadmin" || mode === "system-health") {
    const config = superadminConfigStatus();
    if (!config.hasUsername) push("failed", "superadmin username", "SUPERADMIN_USERNAME is missing.");
    else push("passed", "superadmin username", "SUPERADMIN_USERNAME is configured.");
    if (!config.hasSessionSecret) push("failed", "superadmin session", "SUPERADMIN_SESSION_SECRET is missing.");
    else push("passed", "superadmin session", "SUPERADMIN_SESSION_SECRET is configured.");
    if (config.hasPasswordHash) push("passed", "superadmin password", "SUPERADMIN_PASSWORD_HASH is configured.");
    else if (config.hasTemporaryPassword) push("warning", "superadmin password", "SUPERADMIN_PASSWORD is configured without hash. Rotate to SUPERADMIN_PASSWORD_HASH.");
    else push("failed", "superadmin password", "No superadmin password or hash configured.");
  }

  if (mode === "traffic" || mode === "system-health") {
    const schema = await Promise.all([
      service.from("system_logs").select("id,status_code,ip_address,user_agent,event_type").limit(0),
      service.from("client_logs").select("id,ip_address,user_agent").limit(0)
    ]);
    for (const [index, check] of schema.entries()) {
      if (check.error) push("failed", index === 0 ? "system_logs schema" : "client_logs schema", "Traffic schema is missing.", check.error);
      else push("passed", index === 0 ? "system_logs schema" : "client_logs schema", "Traffic columns exist.");
    }
    const traffic = await buildTrafficAnalytics(service, "7d");
    push(traffic.summary.totalVisits > 0 ? "passed" : "warning", "traffic logs", `${traffic.summary.totalVisits} page views in the last 7 days.`, traffic.summary);
  }

  if (mode === "security" || mode === "system-health") {
    const security = await buildSuperadminSecurity(service);
    push("passed", "security events", `${security.securityEvents.length} security events inspected.`);
    if (security.failedLogins.length > 10) push("warning", "failed logins", `${security.failedLogins.length} failed logins in 24h.`);
    else push("passed", "failed logins", `${security.failedLogins.length} failed logins in 24h.`);
  }

  if (mode === "system-health") {
    const health = await buildSuperadminHealth(service);
    push(health.worker.status === "ok" ? "passed" : "warning", "worker heartbeat", `Worker status: ${health.worker.status}.`, health.worker);
    push(health.jobs.stuck.length ? "warning" : "passed", "stuck jobs", `${health.jobs.stuck.length} stuck jobs found.`, health.jobs.stuck);
    push(health.alerts.length ? "warning" : "passed", "alerts", `${health.alerts.length} active alerts.`, health.alerts);
  }

  print();
  if (results.some((item) => item.status === "failed")) process.exitCode = 1;
}

function print() {
  console.log(JSON.stringify({
    mode,
    passed: results.filter((item) => item.status === "passed"),
    failed: results.filter((item) => item.status === "failed"),
    warnings: results.filter((item) => item.status === "warning")
  }, null, 2));
}

main().catch((error) => {
  push("failed", "diagnostic crash", error instanceof Error ? error.message : String(error));
  print();
  process.exitCode = 1;
});
