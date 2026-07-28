import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
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
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

async function main() {
  const url = getRequiredServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = getSupabaseServiceRoleKey();
  if (!key) throw new Error("Missing Supabase service role key.");
  const supabase = createClient(url, key, serverSupabaseClientOptions());
  const now = new Date().toISOString();
  const { data: expiredFiles, error: fileError } = await supabase
    .from("opportunity_finder_files")
    .select("id,storage_bucket,storage_path")
    .lt("file_expires_at", now)
    .is("storage_deleted_at", null)
    .limit(500);
  if (fileError) throw fileError;

  for (const file of expiredFiles ?? []) {
    const { error } = await supabase.storage.from(file.storage_bucket).remove([file.storage_path]);
    if (error) continue;
    await supabase
      .from("opportunity_finder_files")
      .update({ storage_deleted_at: now })
      .eq("id", file.id);
  }

  const { data: expiredJobs, error: jobError } = await supabase
    .from("opportunity_finder_jobs")
    .select("id")
    .lt("expires_at", now)
    .limit(500);
  if (jobError) throw jobError;
  if (expiredJobs?.length) {
    const { error } = await supabase
      .from("opportunity_finder_jobs")
      .delete()
      .in("id", expiredJobs.map((job) => job.id));
    if (error) throw error;
  }

  process.stdout.write(JSON.stringify({
    expiredFilesProcessed: expiredFiles?.length ?? 0,
    expiredJobsDeleted: expiredJobs?.length ?? 0
  }));
}

main().catch(() => {
  console.error("Opportunity Finder cleanup failed.");
  process.exit(1);
});
