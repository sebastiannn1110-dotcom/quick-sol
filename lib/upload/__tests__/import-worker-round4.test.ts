import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processImportJob, type ImportJobRow } from "@/lib/upload/import-worker";

vi.mock("@/lib/logger/logger", () => ({
  logger: {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined)
  }
}));

vi.mock("@/lib/email/evaluate-alert-rules", () => ({
  evaluateEmailAlertRules: vi.fn(async () => undefined)
}));

type RpcCall = { name: string; args: Record<string, unknown> };

function jobFor(fileName: string, size: number): ImportJobRow {
  return {
    id: "30000000-0000-4000-8000-000000000010",
    upload_batch_id: "20000000-0000-4000-8000-000000000010",
    uploaded_by: "10000000-0000-4000-8000-000000000010",
    status: "processing",
    storage_bucket: "excel-uploads",
    storage_path: `10000000-0000-4000-8000-000000000010/20000000-0000-4000-8000-000000000010/${fileName}`,
    original_file_name: fileName,
    mime_type: fileName.endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: size,
    selected_category: "Auto Detect",
    department: "QA",
    region: "LATAM",
    notes: null,
    total_rows: 0,
    processed_rows: 0,
    successful_rows: 0,
    failed_rows: 0,
    attempts: 1,
    max_attempts: 3,
    locked_by: "worker-test",
    locked_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    next_retry_at: null,
    last_error: null,
    worker_id: "worker-test",
    cancel_requested: false,
    backend_issued: true,
    provenance_status: "verified",
    source: "trusted_upload_api",
    dataset_key: "business_records",
    import_mode: "replace_upload",
    replacement_scope_key: "20000000-0000-4000-8000-000000000010",
    expected_size_bytes: size,
    expected_sha256: null,
    storage_object_id: "40000000-0000-4000-8000-000000000010",
    generation: 1,
    lease_token: 7,
    lease_owner: "worker-test",
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    publication_state: "staging",
    error_code: null
  };
}

function serviceFixture(options?: { validationError?: boolean }) {
  const calls: RpcCall[] = [];
  const service = {
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "https://storage.invalid/synthetic" }, error: null }))
      }))
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "renew_import_job_lease_v2") return { data: { renewed: true, cancelRequested: false }, error: null };
      if (name === "validate_import_job_staging_v2" && options?.validationError) {
        return { data: null, error: { code: "22023", message: "IMPORT_HEADERS_INVALID" } };
      }
      if (name === "fail_import_job_v2") return { data: { status: args.input_retryable ? "retrying" : "failed" }, error: null };
      return { data: true, error: null };
    })
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ronda 4 import worker failures", () => {
  it("treats a missing Storage object as terminal and never publishes", async () => {
    const fixture = serviceFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const job = jobFor("missing.csv", 10);

    await expect(processImportJob(fixture.service, job, "worker-test")).rejects.toThrow();

    expect(fixture.calls).toContainEqual(expect.objectContaining({
      name: "fail_import_job_v2",
      args: expect.objectContaining({ input_error_code: "IMPORT_STORAGE_OBJECT_MISSING", input_retryable: false })
    }));
    expect(fixture.calls.some((call) => call.name === "publish_import_job_v2")).toBe(false);
  });

  it("classifies temporary Storage failure as retryable without publishing", async () => {
    const fixture = serviceFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary", { status: 503 })));
    const job = jobFor("temporary.csv", 9);

    await expect(processImportJob(fixture.service, job, "worker-test")).rejects.toThrow();

    expect(fixture.calls).toContainEqual(expect.objectContaining({
      name: "fail_import_job_v2",
      args: expect.objectContaining({ input_error_code: "IMPORT_STORAGE_DOWNLOAD_FAILED", input_retryable: true })
    }));
    expect(fixture.calls.some((call) => call.name === "publish_import_job_v2")).toBe(false);
  });

  it("rejects a corrupt XLSX as terminal after streaming and before publication", async () => {
    const bytes = new TextEncoder().encode("not-an-xlsx-archive");
    const fixture = serviceFixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));
    const job = jobFor("corrupt.xlsx", bytes.byteLength);

    await expect(processImportJob(fixture.service, job, "worker-test")).rejects.toThrow();

    expect(fixture.calls).toContainEqual(expect.objectContaining({
      name: "fail_import_job_v2",
      args: expect.objectContaining({ input_error_code: "IMPORT_FILE_CORRUPT", input_retryable: false })
    }));
    expect(fixture.calls.some((call) => call.name === "publish_import_job_v2")).toBe(false);
  });

  it("rejects invalid headers after staging without publishing", async () => {
    const bytes = new TextEncoder().encode("unknown_one,unknown_two\nalpha,beta\n");
    const fixture = serviceFixture({ validationError: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));
    const job = jobFor("invalid-headers.csv", bytes.byteLength);

    await expect(processImportJob(fixture.service, job, "worker-test")).rejects.toThrow();

    const sheetStage = fixture.calls.find((call) => call.name === "stage_import_job_rows_v2" && call.args.input_entity_kind === "sheet");
    expect(sheetStage).toBeDefined();
    expect(fixture.calls).toContainEqual(expect.objectContaining({
      name: "fail_import_job_v2",
      args: expect.objectContaining({ input_error_code: "IMPORT_HEADERS_INVALID", input_retryable: false })
    }));
    expect(fixture.calls.some((call) => call.name === "publish_import_job_v2")).toBe(false);
  });
});
