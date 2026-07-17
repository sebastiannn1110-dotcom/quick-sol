"use client";

import CategoryBadge from "@/components/CategoryBadge";
import { useLanguage } from "@/components/LanguageProvider";
import type { BusinessCategory, UploadBatch } from "@/lib/types";

export type UploadWithJob = UploadBatch & {
  latest_import_job?: {
    id: string;
    status: string;
    total_rows: number | null;
    processed_rows: number | null;
    successful_rows: number | null;
    failed_rows: number | null;
    warning_count: number | null;
    rows_with_warnings: number | null;
    technical_error_count: number | null;
    suppressed_error_count: number | null;
    progress_percent: number | null;
    error_message: string | null;
    attempts: number | null;
    max_attempts: number | null;
    locked_by: string | null;
    heartbeat_at: string | null;
    next_retry_at: string | null;
    last_error: string | null;
  } | null;
};

export default function AdminUploadsTable({ uploads }: { uploads: UploadWithJob[] }) {
  const { t, locale } = useLanguage();

  const translateStatus = (status: string) => {
    if (status === "pending") return t("history.status.pending");
    if (status === "pending_upload") return t("history.status.pendingUpload");
    if (status === "uploading") return t("history.status.uploading");
    if (status === "uploaded") return t("history.status.uploaded");
    if (status === "queued") return t("history.status.queued");
    if (status === "retrying") return t("history.status.retrying");
    if (status === "processing") return t("history.status.processing");
    if (status === "completed") return t("history.status.completed");
    if (status === "completed_with_warnings") return t("history.status.completedWithWarnings");
    if (status === "failed") return t("history.status.failed");
    if (status === "cancelled") return t("history.status.cancelled");
    if (status === "archived") return t("history.status.archived");
    return status;
  };

  return (
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
                const progress = upload.status === "completed" || upload.status === "completed_with_warnings"
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
                      <div className="grid gap-1">
                        <span className="w-fit rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{translateStatus(upload.status)}</span>
                        {upload.status === "completed_with_warnings" ? (
                          <span className="text-xs text-amber-700">Archivo procesado con advertencias de calidad.</span>
                        ) : null}
                      </div>
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
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">{upload.technical_error_count ?? upload.failed_rows ?? upload.rows_with_warnings ?? upload.error_count}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">{upload.data_quality_score ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{new Date(upload.created_at).toLocaleString(locale)}</td>
                    <td className="min-w-[180px] px-4 py-3">
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
  );
}
