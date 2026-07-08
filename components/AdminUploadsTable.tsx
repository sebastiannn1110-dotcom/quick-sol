"use client";

import { useMemo, useState } from "react";
import CategoryBadge from "@/components/CategoryBadge";
import DataTable from "@/components/DataTable";
import { useLanguage } from "@/components/LanguageProvider";
import type { BusinessCategory, ImportErrorLog, PlatformRecord, UploadBatch } from "@/lib/types";

interface ImportErrorRow extends ImportErrorLog {
  upload_batches?: { original_file_name: string | null; uploaded_by: string | null } | null;
  upload_sheets?: { sheet_name: string | null } | null;
}

function suggestedFix(errorType: string | null) {
  if (errorType === "missing_required_field") return "Fill the required business field in the source Excel row.";
  if (errorType === "invalid_number") return "Use a clean numeric value without text, symbols or formula errors.";
  if (errorType === "invalid_date") return "Use a valid date format such as YYYY-MM-DD.";
  if (errorType === "formula_error") return "Resolve the Excel formula result before uploading again.";
  if (errorType === "unknown_column" || errorType === "unrecognized_columns") return "Rename the column to a supported business header or keep it as raw data.";
  if (errorType === "empty_value") return "Fill the cell or confirm that the field is optional.";
  if (errorType === "duplicate_record") return "Review duplicate customer, supplier, MPN, PO and quantity combinations.";
  if (errorType === "normalization_failed") return "Check the row format and column headers.";
  return "Review the source row and upload a corrected Excel file.";
}

function ErrorBadge({ severity }: { severity: string | null }) {
  const color =
    severity === "critical"
      ? "bg-red-100 text-red-800"
      : severity === "high"
        ? "bg-amber-100 text-amber-800"
        : severity === "medium"
          ? "bg-blue-100 text-blue-800"
          : "bg-slate-100 text-slate-700";
  return <span className={`rounded-md px-2 py-1 text-xs font-semibold ${color}`}>{severity ?? "low"}</span>;
}

export default function AdminUploadsTable({ uploads }: { uploads: UploadBatch[] }) {
  const { t, locale } = useLanguage();
  const [errors, setErrors] = useState<ImportErrorRow[]>([]);
  const [records, setRecords] = useState<PlatformRecord[]>([]);
  const [modalTitle, setModalTitle] = useState("");
  const [modalKind, setModalKind] = useState<"errors" | "records" | null>(null);
  const [severity, setSeverity] = useState("");
  const [errorType, setErrorType] = useState("");
  const [column, setColumn] = useState("");

  const translateStatus = (status: string) => {
    if (status === "pending") return t("history.status.pending");
    if (status === "pending_upload") return t("history.status.pendingUpload");
    if (status === "uploading") return t("history.status.uploading");
    if (status === "uploaded") return t("history.status.uploaded");
    if (status === "queued") return t("history.status.queued");
    if (status === "retrying") return t("history.status.retrying");
    if (status === "processing") return t("history.status.processing");
    if (status === "completed") return t("history.status.completed");
    if (status === "failed") return t("history.status.failed");
    if (status === "cancelled") return t("history.status.cancelled");
    if (status === "archived") return t("history.status.archived");
    return status;
  };

  const filteredErrors = useMemo(
    () =>
      errors.filter((error) => {
        if (severity && error.severity !== severity) return false;
        if (errorType && error.error_type !== errorType) return false;
        if (column && error.column_name !== column) return false;
        return true;
      }),
    [column, errorType, errors, severity]
  );
  const affectedRows = new Set(errors.map((error) => error.row_index).filter((row) => row !== null)).size;
  const affectedColumns = new Set(errors.map((error) => error.column_name).filter(Boolean)).size;
  const errorTypes = Array.from(new Set(errors.map((error) => error.error_type).filter(Boolean))) as string[];
  const columns = Array.from(new Set(errors.map((error) => error.column_name).filter(Boolean))) as string[];

  async function openErrors(upload: UploadBatch) {
    const response = await fetch(`/api/admin/errors?uploadBatchId=${upload.id}`, { cache: "no-store" });
    const payload = (await response.json()) as { errors: ImportErrorRow[] };
    setErrors(payload.errors ?? []);
    setRecords([]);
    setModalKind("errors");
    setModalTitle(upload.original_file_name);
    setSeverity("");
    setErrorType("");
    setColumn("");
  }

  async function openRecords(upload: UploadBatch) {
    const response = await fetch(`/api/admin/records?uploadBatchId=${upload.id}&pageSize=100`, { cache: "no-store" });
    const payload = (await response.json()) as { records: PlatformRecord[] };
    setRecords(payload.records ?? []);
    setErrors([]);
    setModalKind("records");
    setModalTitle(upload.original_file_name);
  }

  async function openTrace(upload: UploadBatch) {
    const response = await fetch(`/api/admin/errors?uploadBatchId=${upload.id}`, { cache: "no-store" });
    const payload = (await response.json()) as { errors: ImportErrorRow[] };
    const traceId = payload.errors?.find((error) => error.trace_id)?.trace_id;
    if (traceId) window.open(`/admin/traces/${traceId}`, "_blank", "noopener,noreferrer");
    else window.alert("No trace is available for this upload.");
  }

  return (
    <>
      <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.file")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.uploadedBy")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Email</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.category")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.status")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.progress")}</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">{t("history.rows")}</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">{t("history.errors")}</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">Quality</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.uploaded")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Excel</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {uploads.map((upload) => {
                const href = upload.stored_file_path ? `/api/admin/uploads/${upload.id}/download` : null;
                const progress = upload.status === "completed"
                  ? 100
                  : upload.status === "pending_upload" || upload.status === "uploaded"
                    ? upload.upload_progress_percent ?? 0
                    : upload.processing_progress_percent ?? 0;
                return (
                  <tr key={upload.id}>
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-950">{upload.original_file_name}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{upload.profiles?.full_name ?? upload.uploaded_by}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{upload.profiles?.email ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <CategoryBadge category={(upload.detected_category ?? "Generic") as BusinessCategory} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{translateStatus(upload.status)}</span>
                    </td>
                    <td className="min-w-40 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-md bg-slate-200">
                          <div className="h-full bg-brand-600" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-xs font-medium text-slate-600">{progress}%</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">{upload.processed_rows ?? upload.valid_rows}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">{upload.failed_rows ?? upload.error_count}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">{upload.data_quality_score ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{new Date(upload.created_at).toLocaleString(locale)}</td>
                    <td className="min-w-[360px] px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {href ? (
                          <>
                            <a href={href} target="_blank" rel="noreferrer" className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700">
                              {t("history.openExcel")}
                            </a>
                            <a href={href} className="rounded-md border border-orange-200 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-50">
                              Download Excel
                            </a>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">{t("history.noFile")}</span>
                        )}
                        <button type="button" onClick={() => openRecords(upload)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                          View records
                        </button>
                        <button type="button" onClick={() => openErrors(upload)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                          View errors
                        </button>
                        <button type="button" onClick={() => openTrace(upload)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                          View trace
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!uploads.length ? (
                <tr>
                  <td className="px-4 py-8 text-center text-slate-500" colSpan={11}>
                    {t("history.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {modalKind ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-4 sm:items-center">
          <section className="max-h-[90vh] w-full max-w-6xl overflow-auto rounded-md bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
              <div>
                <p className="text-sm font-medium text-orange-700">{modalKind === "errors" ? "Import Error Details" : "Upload Records"}</p>
                <h2 className="break-all text-xl font-semibold text-slate-950">{modalTitle}</h2>
              </div>
              <button type="button" onClick={() => setModalKind(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
                {t("table.close")}
              </button>
            </div>
            <div className="p-4">
              {modalKind === "records" ? <DataTable records={records} /> : null}
              {modalKind === "errors" ? (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs font-medium text-slate-500">Total errors</p>
                      <p className="text-xl font-semibold text-slate-950">{errors.length}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs font-medium text-slate-500">Affected rows</p>
                      <p className="text-xl font-semibold text-slate-950">{affectedRows}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs font-medium text-slate-500">Affected columns</p>
                      <p className="text-xl font-semibold text-slate-950">{affectedColumns}</p>
                    </div>
                    <div className="rounded-md bg-slate-50 p-3">
                      <p className="text-xs font-medium text-slate-500">Error types</p>
                      <p className="text-xl font-semibold text-slate-950">{errorTypes.length}</p>
                    </div>
                  </div>
                  <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    This upload has {errors.length} detected issues across {affectedRows} rows. A row can contain more than one error.
                  </p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <select value={severity} onChange={(event) => setSeverity(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
                      <option value="">All severities</option>
                      {["low", "medium", "high", "critical"].map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <select value={errorType} onChange={(event) => setErrorType(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
                      <option value="">All error types</option>
                      {errorTypes.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <select value={column} onChange={(event) => setColumn(event.target.value)} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm">
                      <option value="">All columns</option>
                      {columns.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </div>
                  <div className="overflow-x-auto rounded-md border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-sm">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Severity</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Type</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Row</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Column</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Raw value</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Message</th>
                          <th className="px-3 py-2 text-left font-semibold text-slate-600">Suggested fix</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredErrors.map((error) => (
                          <tr key={error.id}>
                            <td className="px-3 py-2"><ErrorBadge severity={error.severity} /></td>
                            <td className="px-3 py-2 text-slate-700">{error.error_type ?? "-"}</td>
                            <td className="px-3 py-2 text-slate-700">{error.row_index ?? "-"}</td>
                            <td className="px-3 py-2 text-slate-700">{error.column_name ?? "-"}</td>
                            <td className="max-w-xs px-3 py-2 text-slate-600">{error.raw_value ?? "-"}</td>
                            <td className="max-w-md px-3 py-2 text-slate-600">{error.message ?? "-"}</td>
                            <td className="max-w-md px-3 py-2 text-slate-600">{suggestedFix(error.error_type)}</td>
                          </tr>
                        ))}
                        {!filteredErrors.length ? (
                          <tr>
                            <td className="px-3 py-8 text-center text-slate-500" colSpan={7}>No matching errors.</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
