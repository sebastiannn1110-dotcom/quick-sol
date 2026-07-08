import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

interface DiagnosticStep {
  name: string;
  passed: boolean;
  message: string;
  metadata?: Record<string, unknown>;
}

const steps: DiagnosticStep[] = [];

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

function record(name: string, passed: boolean, message: string, metadata?: Record<string, unknown>) {
  steps.push({ name, passed, message, metadata });
}

function printReport() {
  const passed = steps.filter((step) => step.passed).length;
  const failed = steps.length - passed;
  console.log("\n=== Quiksol Upload Diagnostics ===");
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  console.table(steps.map((step) => ({
    step: step.name,
    passed: step.passed,
    message: step.message,
    metadata: step.metadata ? JSON.stringify(step.metadata) : ""
  })));
}

async function checkOptionalAuthenticatedApi() {
  const baseUrl = (process.env.QUICKSOL_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  const cookie = process.env.QUICKSOL_AUTH_COOKIE;
  if (!baseUrl || !cookie) {
    record("authenticated_api", true, "Skipped. Set QUICKSOL_BASE_URL and QUICKSOL_AUTH_COOKIE to validate the logged-in API path.");
    return;
  }

  const response = await fetch(`${baseUrl}/api/upload`, {
    headers: {
      cookie,
      "User-Agent": "quiksol-upload-diagnostics/1.0"
    }
  });
  record(
    "authenticated_api",
    response.ok,
    response.ok ? "Authenticated upload API responded." : `Authenticated upload API returned HTTP ${response.status}.`,
    response.ok ? undefined : { status: response.status, body: await response.text() }
  );
}

async function main() {
  const { getSupabaseServiceRoleKey } = await import("@/lib/security/env");
  const { serverSupabaseClientOptions } = await import("@/lib/supabase/node-client-options");
  const {
    checkStorageBucket,
    checkUploadSchema,
    getSupabaseErrorMetadata,
    getUploadRuntimeDiagnostics
  } = await import("@/lib/upload/diagnostics");

  const diagnostics = getUploadRuntimeDiagnostics();
  record("env", diagnostics.errors.length === 0, diagnostics.errors.length ? diagnostics.errors.join(" ") : "Upload environment variables are usable.", {
    storageBucket: diagnostics.storageBucket,
    provider: diagnostics.provider,
    backgroundImportsEnabled: diagnostics.backgroundImportsEnabled,
    maxUploadSizeMb: diagnostics.maxUploadSizeMb,
    maxRowsPerFile: diagnostics.maxRowsPerFile,
    maxRowsPerFileEnv: diagnostics.maxRowsPerFileEnv,
    maxExcelRowsEnv: diagnostics.maxExcelRowsEnv,
    warnings: diagnostics.warnings
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = getSupabaseServiceRoleKey();
  if (!supabaseUrl || !serviceRoleKey) {
    record("service_client", false, "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY.");
    printReport();
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, serverSupabaseClientOptions());
  record("service_client", true, "Supabase service client can be created without exposing the key.");

  try {
    await checkUploadSchema(supabase);
    record("database_schema", true, "upload_batches, import_jobs and import_job_errors exist with required columns.");
  } catch (error) {
    record("database_schema", false, "Background import migration is missing or incomplete.", getSupabaseErrorMetadata(error));
  }

  try {
    await checkStorageBucket(supabase, diagnostics.storageBucket);
    record("storage_bucket", true, `Storage bucket ${diagnostics.storageBucket} exists and is accessible.`);
  } catch (error) {
    record("storage_bucket", false, `Storage bucket ${diagnostics.storageBucket} does not exist or is not accessible.`, getSupabaseErrorMetadata(error));
  }

  try {
    const probePath = `diagnostics/${crypto.randomUUID()}.txt`;
    const { error } = await supabase.storage.from(diagnostics.storageBucket).createSignedUploadUrl(probePath);
    record("signed_upload_url", !error, error ? "Unable to create signed upload URL." : "Signed upload URL can be created.", error ? getSupabaseErrorMetadata(error) : { probePath });
  } catch (error) {
    record("signed_upload_url", false, "Unable to create signed upload URL.", getSupabaseErrorMetadata(error));
  }

  await checkOptionalAuthenticatedApi();
  printReport();
  if (steps.some((step) => !step.passed)) process.exitCode = 1;
}

main().catch((error) => {
  record("diagnostics_script", false, error instanceof Error ? error.message : String(error));
  printReport();
  process.exitCode = 1;
});
