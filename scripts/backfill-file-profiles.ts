import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleKey } from "../lib/security/env";
import { serverSupabaseClientOptions } from "../lib/supabase/node-client-options";
import { ensureUploadStructureProfile } from "../lib/upload/structure-profile";

loadEnvConfig(process.cwd());

type JsonRecord = Record<string, unknown>;

function arg(name: string) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function assertUuid(value: string | undefined, name: string) {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Missing or invalid ${name}.`);
  }
  return value;
}

function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseServiceRoleKey();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY.");
  }
  return createClient(url, key, serverSupabaseClientOptions());
}

function safeErrorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const record = error as JsonRecord;
    const parts = [record.message, record.code, record.details, record.hint].filter(Boolean).map(String);
    if (parts.length) return parts.join(" | ").slice(0, 400);
  }
  return String(error instanceof Error ? error.message : error ?? "Unknown error").slice(0, 400);
}

async function uploadIdsWithoutProfiles(supabase: SupabaseClient, options: { limit: number; all: boolean }) {
  const profiles = await supabase.from("file_schema_profiles").select("upload_batch_id").limit(10000);
  if (profiles.error) throw profiles.error;
  const profiledIds = new Set((profiles.data ?? []).map((item) => String(item.upload_batch_id)));

  const uploads = await supabase
    .from("upload_batches")
    .select("id")
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(options.all ? 10000 : options.limit);
  if (uploads.error) throw uploads.error;

  return (uploads.data ?? [])
    .map((upload) => String(upload.id))
    .filter((id) => !profiledIds.has(id));
}

async function main() {
  const startedAt = Date.now();
  const supabase = createServiceClient();
  const uploadBatchId = arg("uploadBatchId") ?? arg("upload-batch-id");
  const limit = Math.min(Math.max(Number(arg("limit") ?? 100) || 100, 1), 1000);
  const all = hasFlag("all");
  const targetIds = uploadBatchId
    ? [assertUuid(uploadBatchId, "uploadBatchId")]
    : await uploadIdsWithoutProfiles(supabase, { limit, all });

  let generated = 0;
  const failed: Array<{ uploadBatchId: string; error: string }> = [];
  for (const id of targetIds) {
    try {
      await ensureUploadStructureProfile(supabase, id);
      generated += 1;
    } catch (error) {
      failed.push({ uploadBatchId: id, error: safeErrorMessage(error) });
    }
  }

  console.log(JSON.stringify({
    mode: "backfill-file-profiles",
    targetedUploads: targetIds.length,
    generatedProfiles: generated,
    failedProfiles: failed.length,
    failed,
    printedDataPolicy: "No row values, customer names, supplier names, prices, costs, PO, notes or MPN values are printed.",
    durationMs: Date.now() - startedAt
  }, null, 2));

  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(safeErrorMessage(error));
  console.error("No raw row values were printed.");
  process.exit(1);
});
