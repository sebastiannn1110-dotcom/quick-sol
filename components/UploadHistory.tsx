"use client";

import type { BusinessCategory, Upload, UploadBatch } from "@/lib/types";
import CategoryBadge from "@/components/CategoryBadge";
import { useLanguage } from "@/components/LanguageProvider";

type UploadLike = Upload | UploadBatch;

function isBatch(upload: UploadLike): upload is UploadBatch {
  return "original_file_name" in upload;
}

function categoryOf(upload: UploadLike) {
  const category = isBatch(upload) ? upload.detected_category : upload.detectedCategory;
  return (category || "Generic") as BusinessCategory;
}

function fileNameOf(upload: UploadLike) {
  return isBatch(upload) ? upload.original_file_name : upload.originalFileName;
}

function employeeOf(upload: UploadLike) {
  if (isBatch(upload)) return upload.profiles?.full_name ?? upload.uploaded_by;
  return `${upload.employeeName} (${upload.employeeId})`;
}

function rowsOf(upload: UploadLike) {
  return isBatch(upload) ? upload.processed_rows ?? upload.valid_rows : upload.validRows;
}

function errorsOf(upload: UploadLike) {
  return isBatch(upload) ? upload.failed_rows ?? upload.error_count : upload.invalidRows;
}

function dateOf(upload: UploadLike) {
  return isBatch(upload) ? upload.created_at : upload.uploadedAt;
}

function statusOf(upload: UploadLike) {
  return isBatch(upload) ? upload.status : "completed";
}

function progressOf(upload: UploadLike) {
  if (!isBatch(upload)) return 100;
  if (upload.status === "completed") return 100;
  if (upload.status === "pending_upload" || upload.status === "uploaded") return upload.upload_progress_percent ?? 0;
  return upload.processing_progress_percent ?? 0;
}

function downloadHref(upload: UploadLike) {
  if (!isBatch(upload) || !upload.stored_file_path) return null;
  return `/api/admin/uploads/${upload.id}/download`;
}

export default function UploadHistory({ uploads, showDownload = false }: { uploads: UploadLike[]; showDownload?: boolean }) {
  const { t, locale } = useLanguage();
  const translateStatus = (status: string) => {
    if (status === "pending") return t("history.status.pending");
    if (status === "pending_upload") return t("history.status.pendingUpload");
    if (status === "uploading") return t("history.status.uploading");
    if (status === "uploaded") return t("history.status.uploaded");
    if (status === "queued") return t("history.status.queued");
    if (status === "processing") return t("history.status.processing");
    if (status === "completed") return t("history.status.completed");
    if (status === "failed") return t("history.status.failed");
    if (status === "cancelled") return t("history.status.cancelled");
    if (status === "archived") return t("history.status.archived");
    return status;
  };

  return (
    <section className="rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">{t("history.title")}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.file")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.uploadedBy")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.category")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.status")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.progress")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.rows")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.errors")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.uploaded")}</th>
              {showDownload ? <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("history.excel")}</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {uploads.map((upload) => {
              const href = downloadHref(upload);
              const progress = progressOf(upload);
              return (
                <tr key={upload.id}>
                  <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">
                    {fileNameOf(upload)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{employeeOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <CategoryBadge category={categoryOf(upload)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {translateStatus(statusOf(upload))}
                    </span>
                  </td>
                  <td className="min-w-40 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-md bg-slate-200">
                        <div className="h-full bg-brand-600" style={{ width: `${progress}%` }} />
                      </div>
                      <span className="text-xs font-medium text-slate-600">{progress}%</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{rowsOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{errorsOf(upload)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {new Date(dateOf(upload)).toLocaleString(locale)}
                  </td>
                  {showDownload ? (
                    <td className="whitespace-nowrap px-4 py-3">
                      {href ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                        >
                          {t("history.openExcel")}
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">{t("history.noFile")}</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {!uploads.length ? (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={showDownload ? 9 : 8}>
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
