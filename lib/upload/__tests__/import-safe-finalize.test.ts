import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSafeFinalizeAssessment,
  finalizeImportJobSafely,
  redactDiagnosticText,
  type ImportDiagnosticsCounts
} from "@/lib/upload/job-diagnostics";

const COMPLETE_WARNING_COUNTS: ImportDiagnosticsCounts = {
  rowsTotal: 48000,
  rowsProcessed: 48000,
  rowsImported: 48000,
  failedRows: 0,
  businessRecords: 48000,
  businessRecordsWithWarnings: 48000,
  recordOverflow: 0,
  technicalErrors: 0,
  warningCount: 144000,
  rowsWithWarnings: 48000,
  suppressedWarnings: 0,
  importErrorSamples: 144000,
  technicalImportErrorSamples: 0,
  jobErrorSamples: 144000,
  groupedWarnings: 3
};

class FakeQuery {
  private filters = new Map<string, unknown>();
  private orFilter: string | null = null;
  private head = false;
  private updatePayload: Record<string, unknown> | null = null;

  constructor(
    private readonly table: string,
    private readonly state: {
      updates: Array<{ table: string; payload: Record<string, unknown> }>;
    }
  ) {}

  select(_columns: string, options?: { count?: string; head?: boolean }) {
    this.head = Boolean(options?.head);
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.updatePayload = payload;
    this.state.updates.push({ table: this.table, payload });
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.set(column, value);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.set(column, value);
    return this;
  }

  or(filter: string) {
    this.orFilter = filter;
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  maybeSingle() {
    if (this.table === "import_jobs") {
      return Promise.resolve({
        data: {
          id: "job-1",
          upload_batch_id: "batch-1",
          status: "retrying",
          total_rows: 48000,
          processed_rows: 48000,
          successful_rows: 48000,
          failed_rows: 0,
          attempts: 2,
          max_attempts: 3,
          warning_count: 144000,
          rows_with_warnings: 48000,
          technical_error_count: 0,
          suppressed_error_count: 0,
          progress_percent: 95,
          error_message: null,
          last_error: "Processing failed and will be retried by the worker.",
          heartbeat_at: null,
          locked_by: "worker-1",
          locked_at: null,
          next_retry_at: null,
          started_at: null,
          finished_at: null,
          duration_ms: null,
          original_file_name: "synthetic.xlsx",
          worker_id: "worker-1"
        },
        error: null
      });
    }

    if (this.table === "upload_batches") {
      return Promise.resolve({
        data: {
          id: "batch-1",
          status: "retrying",
          total_rows: 48000,
          processed_rows: 48000,
          valid_rows: 48000,
          invalid_rows: 0,
          successful_rows: 48000,
          failed_rows: 0,
          error_count: 144000,
          warning_count: 144000,
          rows_with_warnings: 48000,
          technical_error_count: 0,
          suppressed_error_count: 0,
          processing_progress_percent: 95,
          error_message: "Processing failed and will be retried by the worker.",
          worker_last_heartbeat_at: null
        },
        error: null
      });
    }

    return Promise.resolve({ data: null, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }

  private resolve() {
    if (this.updatePayload) return { error: null };
    if (!this.head && this.table === "import_job_error_summary") {
      return {
        data: [
          {
            error_type: "data_quality_warning",
            severity: "low",
            message: "Synthetic warning message for field format.",
            occurrence_count: 144000,
            sample_row_number: 2
          }
        ],
        error: null
      };
    }

    if (this.table === "business_records") {
      return { count: this.filters.get("has_errors") === true ? 48000 : 48000, error: null };
    }

    if (this.table === "import_errors") {
      return { count: this.orFilter ? 0 : 144000, error: null };
    }

    if (this.table === "import_job_errors") return { count: 144000, error: null };
    if (this.table === "import_job_error_summary") return { count: 1, error: null };
    return { count: 0, error: null };
  }
}

function createFakeSupabase() {
  const state = { updates: [] as Array<{ table: string; payload: Record<string, unknown> }> };
  const supabase = {
    from(table: string) {
      return new FakeQuery(table, state);
    }
  } as unknown as SupabaseClient;
  return { supabase, state };
}

describe("import safe finalize", () => {
  it("allows safe finalize when all rows imported with warnings and no technical errors", () => {
    const assessment = buildSafeFinalizeAssessment({
      jobStatus: "retrying",
      counts: COMPLETE_WARNING_COUNTS
    });

    expect(assessment.possible).toBe(true);
    expect(assessment.recommendedAction).toBe("Run safe finalize.");
  });

  it("blocks safe finalize when a technical error is recorded", () => {
    const assessment = buildSafeFinalizeAssessment({
      jobStatus: "retrying",
      counts: { ...COMPLETE_WARNING_COUNTS, technicalErrors: 1 }
    });

    expect(assessment.possible).toBe(false);
    expect(assessment.recommendedAction).toContain("technical error");
  });

  it("redacts sensitive diagnostic text", () => {
    expect(redactDiagnosticText("Email user@example.com PO 123456789 total $42,000")).toBe(
      "Email [redacted_email] PO [redacted_number] total [redacted_amount]"
    );
  });

  it("updates existing job and upload columns to completed_with_warnings", async () => {
    const { supabase, state } = createFakeSupabase();
    const result = await finalizeImportJobSafely(supabase, "job-1");

    expect(result.finalized).toBe(true);
    expect(result.status).toBe("completed_with_warnings");
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "import_jobs",
          payload: expect.objectContaining({
            status: "completed_with_warnings",
            progress_percent: 100,
            error_message: null,
            last_error: null,
            technical_error_count: 0
          })
        }),
        expect.objectContaining({
          table: "upload_batches",
          payload: expect.objectContaining({
            status: "completed_with_warnings",
            processing_progress_percent: 100,
            error_message: "Archivo procesado con advertencias de calidad.",
            technical_error_count: 0
          })
        })
      ])
    );
  });

  it("reports record overflow without blocking safe finalize", () => {
    const assessment = buildSafeFinalizeAssessment({
      jobStatus: "failed",
      counts: {
        ...COMPLETE_WARNING_COUNTS,
        rowsTotal: 58000,
        rowsProcessed: 58000,
        rowsImported: 58000,
        businessRecords: 118000,
        businessRecordsWithWarnings: 118000,
        recordOverflow: 60000
      }
    });

    expect(assessment.possible).toBe(true);
  });
});
