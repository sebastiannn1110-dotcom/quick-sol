"use client";

import { FileSpreadsheet } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { ClientUpload } from "@/lib/clients/clients";
import type { TranslationKey } from "@/lib/i18n";

const STATUS_KEYS: Record<string, TranslationKey> = {
  pending: "history.status.pending",
  pending_upload: "history.status.pendingUpload",
  uploading: "history.status.uploading",
  uploaded: "history.status.uploaded",
  queued: "history.status.queued",
  retrying: "history.status.retrying",
  processing: "history.status.processing",
  completed: "history.status.completed",
  completed_with_warnings: "history.status.completedWithWarnings",
  failed: "history.status.failed",
  cancelled: "history.status.cancelled",
  archived: "history.status.archived"
};

export default function ClientFiles({ uploads }: { uploads: ClientUpload[] }) {
  const { locale, t } = useLanguage();
  const statusLabel = (status: string) => STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status;
  if (!uploads.length) return <div className="py-10 text-center text-sm text-slate-500">{t("clientFiles.empty")}</div>;

  return (
    <>
      <div className="grid gap-3 md:hidden">
        {uploads.map((upload) => (
          <div key={upload.id} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
              <div className="min-w-0">
                <p className="break-words font-medium text-slate-950">{upload.originalFileName}</p>
                <p className="mt-1 text-sm text-slate-500">{upload.detectedCategory ?? "-"} · {statusLabel(upload.status)}</p>
                <p className="mt-2 text-xs text-slate-500">{new Intl.DateTimeFormat(locale).format(new Date(upload.createdAt))} · {upload.totalRows} {t("clientFiles.rows")}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-md border border-slate-200 bg-white md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">{t("clientFiles.file")}</th>
              <th className="px-4 py-3">{t("clientFiles.date")}</th>
              <th className="px-4 py-3">{t("clientFiles.category")}</th>
              <th className="px-4 py-3">{t("clientFiles.status")}</th>
              <th className="px-4 py-3 text-right">{t("clientFiles.rows")}</th>
              <th className="px-4 py-3 text-right">{t("clientFiles.warnings")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {uploads.map((upload) => (
              <tr key={upload.id}>
                <td className="max-w-sm px-4 py-3 font-medium text-slate-950"><span className="block truncate">{upload.originalFileName}</span></td>
                <td className="px-4 py-3 text-slate-600">{new Intl.DateTimeFormat(locale).format(new Date(upload.createdAt))}</td>
                <td className="px-4 py-3 text-slate-600">{upload.detectedCategory ?? "-"}</td>
                <td className="px-4 py-3 text-slate-600">{statusLabel(upload.status)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{upload.totalRows}</td>
                <td className="px-4 py-3 text-right tabular-nums">{upload.warningCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
