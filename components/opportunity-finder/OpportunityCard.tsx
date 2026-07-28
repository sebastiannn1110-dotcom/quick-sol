"use client";

import { useState } from "react";
import { ChevronDown, Download, FileSpreadsheet, TriangleAlert } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  OPPORTUNITY_TYPE_LABELS,
  opportunityActionLabel,
  opportunityFinderCopy,
  opportunityReasonLabel,
  opportunityWarningLabel
} from "@/lib/opportunity-finder/i18n";
import type { OpportunityResult } from "@/lib/opportunity-finder/types";

const TYPE_STYLES: Record<OpportunityResult["opportunityType"], string> = {
  full_sale: "border-emerald-200 bg-emerald-50 text-emerald-800",
  partial_sale: "border-amber-200 bg-amber-50 text-amber-800",
  sourcing_needed: "border-red-200 bg-red-50 text-red-800",
  excess_resale: "border-violet-200 bg-violet-50 text-violet-800",
  supplier_offer_match: "border-blue-200 bg-blue-50 text-blue-800",
  supply_without_demand: "border-slate-200 bg-slate-100 text-slate-700",
  historical_signal: "border-cyan-200 bg-cyan-50 text-cyan-800",
  review_required: "border-orange-200 bg-orange-50 text-orange-800"
};

function valueOrDash(value: number | null, locale: string) {
  return value === null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
}

export default function OpportunityCard({
  result,
  jobId
}: {
  result: OpportunityResult;
  jobId: string;
}) {
  const { language, locale } = useLanguage();
  const text = opportunityFinderCopy(language);
  const [showSource, setShowSource] = useState(false);

  const metrics = [
    [text.card.required, valueOrDash(result.requiredQty, locale)],
    [text.card.available, valueOrDash(result.availableQty, locale)],
    [text.card.allocated, valueOrDash(result.allocatedQty, locale)],
    [text.card.shortage, valueOrDash(result.shortageQty, locale)],
    [text.card.coverage, result.coveragePercent === null ? "—" : `${valueOrDash(result.coveragePercent, locale)} %`],
    [text.card.unit, result.unitOfMeasure ?? text.card.unspecified]
  ] as const;

  return (
    <article className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${TYPE_STYLES[result.opportunityType]}`}>
          {OPPORTUNITY_TYPE_LABELS[language][result.opportunityType]}
        </span>
        {result.warnings.length ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-700">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {result.warnings.length}
          </span>
        ) : null}
      </div>

      <h3 className="mt-4 break-all text-xl font-bold text-slate-950">MPN: {result.displayMpn}</h3>
      <div className="mt-2 space-y-1 text-sm text-slate-600">
        <p><span className="font-semibold text-slate-700">{text.card.manufacturer}:</span> {result.manufacturer ?? text.card.unspecified}</p>
        {result.customerContext ? <p><span className="font-semibold text-slate-700">{text.card.customer}:</span> {result.customerContext}</p> : null}
        {result.supplierContext ? <p><span className="font-semibold text-slate-700">{text.card.supplier}:</span> {result.supplierContext}</p> : null}
        {result.requiredDate ? <p><span className="font-semibold text-slate-700">{text.card.requiredDate}:</span> {result.requiredDate}</p> : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        {metrics.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-lg bg-slate-50 p-3">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
            <dd className="mt-1 break-words text-sm font-bold text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.card.reason}</p>
          <p className="mt-1 text-slate-700">{opportunityReasonLabel(language, result.reasonCode)}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.card.action}</p>
          <p className="mt-1 font-medium text-slate-900">{opportunityActionLabel(language, result.actionCode)}</p>
        </div>
        {result.warnings.length ? (
          <div className="flex flex-wrap gap-2">
            {result.warnings.map((warning) => (
              <span key={warning} className="rounded-md bg-orange-50 px-2 py-1 text-xs font-medium text-orange-800">
                {opportunityWarningLabel(language, warning)}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {showSource ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="flex items-start gap-2">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 space-y-2">
              <p className="break-words">
                <span className="font-semibold text-slate-800">{text.card.demandSource}:</span>{" "}
                {[result.demandFileName, result.demandSheetName].filter(Boolean).join(" / ") || "—"}
                {result.demandSourceRows ? ` · ${result.demandSourceRows} ${text.card.groupedRows.toLowerCase()}` : ""}
              </p>
              <p className="break-words">
                <span className="font-semibold text-slate-800">{text.card.supplySource}:</span>{" "}
                {[result.supplyFileName, result.supplySheetName].filter(Boolean).join(" / ") || "—"}
                {result.supplySourceRows ? ` · ${result.supplySourceRows} ${text.card.groupedRows.toLowerCase()}` : ""}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setShowSource((value) => !value)}
          className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          <ChevronDown className={`h-4 w-4 transition ${showSource ? "rotate-180" : ""}`} aria-hidden="true" />
          {showSource ? text.card.hideSource : text.card.viewSource}
        </button>
        <a
          href={`/api/opportunity-finder/jobs/${jobId}/export?format=xlsx&resultId=${result.id}&lang=${language}`}
          className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-brand-200 px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {text.card.export}
        </a>
      </div>
    </article>
  );
}
