import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("duplicate cleanup scripts", () => {
  it("forces JSON output for heavy Supabase CLI cleanup queries", () => {
    const cleanup = source("scripts/import-duplicate-cleanup.ts");

    expect(cleanup).toContain("supabase db query --linked --output-format json --file");
    expect(cleanup).toContain("Unable to parse Supabase CLI JSON output");
    expect(cleanup).toContain("Array.isArray(parsed)");
    expect(cleanup).toContain("record.rows");
    expect(cleanup).not.toContain("supabase db query --linked --file");
  });

  it("preflights the exact public.import_jobs lookup before duplicate diagnostics", () => {
    const cleanup = source("scripts/import-duplicate-cleanup.ts");

    expect(cleanup).toContain("async function getJobLookup");
    expect(cleanup).toContain("from public.import_jobs");
    expect(cleanup).toContain("where id = ${sqlLiteral(jobId)}::uuid");
    expect(cleanup).toContain("SQL returned 0 rows from public.import_jobs");
    expect(cleanup.indexOf("const jobLookup = await getJobLookup(jobId, debug)")).toBeLessThan(
      cleanup.indexOf("'jobId', (select id from job)")
    );
  });

  it("supports safe debug output without raw business payloads", () => {
    const cleanup = source("scripts/import-duplicate-cleanup.ts");

    expect(cleanup).toContain('const debug = hasFlag("debug")');
    expect(cleanup).toContain('label: "args"');
    expect(cleanup).toContain('label: "job_lookup_parsed"');
    expect(cleanup).toContain('label: "duplicate_diagnostics_parsed"');
    expect(cleanup).not.toContain("'rawData'");
    expect(cleanup).not.toContain('"rawData"');
    expect(cleanup).not.toContain("'normalizedData'");
    expect(cleanup).not.toContain('"normalizedData"');
  });

  it("uses the Supabase PostgREST client path for restore", () => {
    const restore = source("scripts/restore-duplicate-cleanup.ts");

    expect(restore).toContain("@supabase/postgrest-js");
    expect(restore).toContain("PostgrestClient");
    expect(restore).not.toContain("supabase db query");
    expect(restore).not.toContain("parseCliJson");
    expect(restore).not.toContain("child_process");
  });

  it("prints a no-modification message on pre-mutation failures", () => {
    const cleanup = source("scripts/import-duplicate-cleanup.ts");
    const restore = source("scripts/restore-duplicate-cleanup.ts");

    expect(cleanup).toContain("No records were modified.");
    expect(cleanup).toContain("if (!mutationStarted)");
    expect(restore).toContain("No records were modified.");
    expect(restore).toContain("if (!mutationStarted)");
  });

  it("generates backup_before_soft_archive before archive and restore rejects dry-run reports", () => {
    const cleanup = source("scripts/import-duplicate-cleanup.ts");
    const restore = source("scripts/restore-duplicate-cleanup.ts");

    expect(cleanup).toContain("backup_before_soft_archive");
    expect(cleanup.indexOf("await assertReportExists(reportPath)")).toBeLessThan(cleanup.indexOf("const cleanup = await applySoftArchive("));
    expect(restore).toContain('report.mode !== "backup_before_soft_archive"');
    expect(restore).toContain("Restore requires a backup_before_soft_archive report");
  });
});
