"use client";

import { HelpCircle, Maximize2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

function formatValue(value: number | string, locale: string) {
  if (typeof value === "string") return value;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2
  }).format(value);
}

export default function MetricCard({
  label,
  value,
  detail,
  description,
  onOpen
}: {
  label: string;
  value: string | number;
  detail?: string;
  description?: string;
  onOpen?: () => void;
}) {
  const { t, tl, locale } = useLanguage();

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{tl(label)}</p>
        {description ? (
          <span title={description} aria-label={description} className="rounded-full text-slate-400">
            <HelpCircle className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{formatValue(value, locale)}</p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{tl(detail)}</p> : null}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="focus-ring mt-3 inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {t("analytics.viewDetails")}
        </button>
      ) : null}
    </div>
  );
}
