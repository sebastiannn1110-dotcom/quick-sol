"use client";

import type { Language } from "@/lib/i18n";
import { rfqStatusLabel } from "@/lib/commerce/ui-i18n";
import type { CommerceRfqStatus } from "@/lib/commerce/ui-model";

const STATUS_STYLE: Record<CommerceRfqStatus, string> = {
  unassigned: "border-amber-200 bg-amber-50 text-amber-800",
  assigned: "border-sky-200 bg-sky-50 text-sky-800",
  in_review: "border-violet-200 bg-violet-50 text-violet-800",
  quoted: "border-emerald-200 bg-emerald-50 text-emerald-800",
  cancelled: "border-slate-200 bg-slate-100 text-slate-600"
};

export default function RfqStatusChip({
  status,
  language,
  isNew = false
}: {
  status: CommerceRfqStatus;
  language: Language;
  isNew?: boolean;
}) {
  if (isNew) {
    return (
      <span className="inline-flex rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-bold tracking-wide text-orange-800">
        {language === "es" ? "NUEVO" : language === "zh" ? "新询价" : "NEW"}
      </span>
    );
  }
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${STATUS_STYLE[status]}`}>
      {rfqStatusLabel(status, language)}
    </span>
  );
}
