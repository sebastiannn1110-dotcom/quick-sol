import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("upload diagnostics", () => {
  it("reports a missing service role key with the explicit production message", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;

    const { getUploadRuntimeDiagnostics } = await import("@/lib/upload/diagnostics");

    expect(getUploadRuntimeDiagnostics().errors).toContain(
      "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY for upload initiation."
    );
  });

  it("uses the safe row limit when only a dangerous legacy MAX_EXCEL_ROWS is set", async () => {
    process.env.MAX_EXCEL_ROWS = "200000000";
    delete process.env.MAX_ROWS_PER_FILE;

    const { getUploadRuntimeDiagnostics } = await import("@/lib/upload/diagnostics");
    const diagnostics = getUploadRuntimeDiagnostics();

    expect(diagnostics.maxRowsPerFile).toBe(100000);
    expect(diagnostics.warnings.join(" ")).toContain("MAX_EXCEL_ROWS=200000000 is too high");
  });

  it("classifies missing migration and RLS database failures", async () => {
    const { uploadDatabaseError } = await import("@/lib/upload/diagnostics");

    expect(uploadDatabaseError("db failed", { code: "PGRST205", message: "table not found" }).code).toBe("UPLOAD_MIGRATION_MISSING");
    expect(uploadDatabaseError("db failed", { code: "42501", message: "permission denied" }).code).toBe("UPLOAD_RLS_BLOCKED");
  });

  it("classifies missing Storage bucket failures", async () => {
    const { uploadStorageError } = await import("@/lib/upload/diagnostics");

    expect(uploadStorageError("storage failed", { message: "Bucket not found" }, { storageBucket: "excel-uploads" }).code).toBe("UPLOAD_STORAGE_BUCKET_MISSING");
  });
});
