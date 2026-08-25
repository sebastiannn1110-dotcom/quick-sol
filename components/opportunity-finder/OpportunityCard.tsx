"use client";

import { useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  TriangleAlert,
  X
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  OPPORTUNITY_TYPE_LABELS,
  opportunityActionLabel,
  opportunityFinderCopy,
  opportunityReasonLabel,
  opportunityWarningLabel
} from "@/lib/opportunity-finder/i18n";
import type {
  OpportunityResult,
  OpportunityReviewStatus,
  OpportunitySourceTrace
} from "@/lib/opportunity-finder/types";

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

function valueOrDash(value: number | null | undefined, locale: string) {
  return value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
}

function percentageOrDash(value: number | null | undefined, locale: string) {
  return value === null || value === undefined ? "—" : `${valueOrDash(value, locale)} %`;
}

function commercialValue(value: number | null | undefined, currency: string | null | undefined, locale: string) {
  if (value === null || value === undefined) return "—";
  return `${valueOrDash(value, locale)}${currency ? ` ${currency}` : ""}`;
}

function readableCode(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "—";
}

export default function OpportunityCard({
  result,
  jobId,
  canViewPricing = false,
  canViewFinancials = false,
  reviewing = false,
  onReview
}: {
  result: OpportunityResult;
  jobId: string;
  canViewPricing?: boolean;
  canViewFinancials?: boolean;
  reviewing?: boolean;
  onReview?: (decision: "approved" | "rejected") => void | Promise<void>;
}) {
  const { language, locale } = useLanguage();
  const text = opportunityFinderCopy(language);
  const [showSource, setShowSource] = useState(false);

  const metrics = [
    [text.card.required, valueOrDash(result.requiredQty, locale)],
    [text.card.available, valueOrDash(result.availableQty, locale)],
    [text.card.allocated, valueOrDash(result.allocatedQty, locale)],
    [text.card.shortage, valueOrDash(result.shortageQty, locale)],
    [text.card.coverage, percentageOrDash(result.coveragePercent, locale)],
    [text.card.unit, result.unitOfMeasure ?? text.card.unspecified]
  ] as const;
  const matchIndicators = [
    [text.card.exactMpnMatch, result.exactMpnMatch],
    [text.card.usableAvailabilityMatch, result.usableAvailabilityMatch],
    [text.card.exactQuantity, result.exactQuantityMatch]
  ] as const;
  const terms = [
    [text.card.moq, valueOrDash(result.moq, locale)],
    [text.card.spq, valueOrDash(result.spq, locale)],
    [text.card.dateCode, result.dateCode ?? "—"],
    [text.card.coo, result.coo ?? "—"],
    [text.card.leadTime, result.leadTimeWeeks == null ? "—" : `${valueOrDash(result.leadTimeWeeks, locale)} wk`],
    [text.card.condition, result.condition ?? "—"],
    [text.card.expiresAt, result.expiresAt ?? "—"]
  ].filter(([, value]) => value !== "—");
  const reviewStatus: OpportunityReviewStatus = result.reviewStatus ?? "not_required";
  const reviewLabel = {
    not_required: text.review.notRequired,
    pending: text.review.pending,
    approved: text.review.approved,
    rejected: text.review.rejected
  }[reviewStatus];

  function Trace({ trace }: { trace: OpportunitySourceTrace }) {
    const columns = Object.entries(trace.columns ?? {});
    return (
      <div className="rounded-md border border-slate-200 bg-white p-2.5">
        <p className="break-words font-semibold text-slate-800">
          {trace.fileName} / {trace.sheetName} · {text.card.row} {trace.sourceRow}
          {trace.hidden ? ` · ${text.card.hidden}` : ""}
        </p>
        {columns.length ? (
          <p className="mt-1 break-words text-slate-500">
            <span className="font-semibold">{text.card.sourceColumns}:</span>{" "}
            {columns.map(([field, cell]) => `${field}: ${cell}`).join(" · ")}
          </p>
        ) : null}
      </div>
    );
  }

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
      {result.demandMpnOriginal || result.supplyMpnOriginal ? (
        <p className="mt-1 break-words text-xs text-slate-500">
          {[result.demandMpnOriginal, result.supplyMpnOriginal].filter(Boolean).join(" ↔ ")}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {matchIndicators.map(([label, active]) => (
          <span
            key={label}
            className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
              active
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-slate-200 bg-slate-50 text-slate-600"
            }`}
          >
            {label}: {active ? text.card.yes : text.card.no}
          </span>
        ))}
      </div>
      <dl className="mt-3 grid gap-x-3 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
        <div><dt className="inline font-semibold text-slate-700">{text.card.matchTier}: </dt><dd className="inline capitalize">{readableCode(result.matchTier)}</dd></div>
        <div><dt className="inline font-semibold text-slate-700">{text.card.confidence}: </dt><dd className="inline capitalize">{readableCode(result.confidence)}</dd></div>
        <div><dt className="inline font-semibold text-slate-700">{text.card.reviewStatus}: </dt><dd className="inline">{reviewLabel}</dd></div>
        {result.demandEventKey ? <div><dt className="inline font-semibold text-slate-700">{text.card.demandEvent}: </dt><dd className="inline break-all">{result.demandEventKey}</dd></div> : null}
      </dl>
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

      {terms.length ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-3 text-xs sm:grid-cols-3">
          {terms.map(([label, value]) => <div key={label}><dt className="font-semibold text-slate-500">{label}</dt><dd className="mt-0.5 break-words text-slate-900">{value}</dd></div>)}
        </dl>
      ) : null}

      {canViewPricing ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs sm:grid-cols-4">
          <div><dt className="font-semibold text-blue-700">{text.card.targetPrice}</dt><dd className="mt-1 font-bold text-slate-900">{commercialValue(result.targetPrice, result.currency, locale)}</dd></div>
          <div><dt className="font-semibold text-blue-700">{text.card.offerPrice}</dt><dd className="mt-1 font-bold text-slate-900">{commercialValue(result.offerPrice, result.currency, locale)}</dd></div>
          <div><dt className="font-semibold text-blue-700">{text.card.targetGap}</dt><dd className="mt-1 font-bold text-slate-900">{percentageOrDash(result.targetGapPercent, locale)}</dd></div>
          <div><dt className="font-semibold text-blue-700">{text.card.revenue}</dt><dd className="mt-1 font-bold text-slate-900">{commercialValue(result.revenuePotential, result.currency, locale)}</dd></div>
        </dl>
      ) : null}

      {canViewFinancials ? (
        <dl className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-violet-100 bg-violet-50/50 p-3 text-xs">
          <div><dt className="font-semibold text-violet-700">{text.card.unitCost}</dt><dd className="mt-1 font-bold text-slate-900">{commercialValue(result.unitCost, result.currency, locale)}</dd></div>
          <div><dt className="font-semibold text-violet-700">{text.card.grossProfit}</dt><dd className="mt-1 font-bold text-slate-900">{commercialValue(result.grossProfit, result.currency, locale)}</dd></div>
          <div><dt className="font-semibold text-violet-700">{text.card.grossMargin}</dt><dd className="mt-1 font-bold text-slate-900">{percentageOrDash(result.grossMarginPercent, locale)}</dd></div>
        </dl>
      ) : null}

      <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.card.reason}</p>
          <p className="mt-1 text-slate-700">{opportunityReasonLabel(language, result.reasonCode)}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.card.action}</p>
          <p className="mt-1 font-medium text-slate-900">{opportunityActionLabel(language, result.actionCode)}</p>
        </div>
        {result.matchExplanation ? <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">{result.matchExplanation}</p> : null}
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
        <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          <div className="flex items-start gap-2">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 space-y-2">
              <p className="break-words"><span className="font-semibold text-slate-800">{text.card.demandSource}:</span>{" "}{[result.demandFileName, result.demandSheetName].filter(Boolean).join(" / ") || "—"}{result.demandSourceRows ? ` · ${result.demandSourceRows} ${text.card.groupedRows.toLowerCase()}` : ""}</p>
              <p className="break-words"><span className="font-semibold text-slate-800">{text.card.supplySource}:</span>{" "}{[result.supplyFileName, result.supplySheetName].filter(Boolean).join(" / ") || "—"}{result.supplySourceRows ? ` · ${result.supplySourceRows} ${text.card.groupedRows.toLowerCase()}` : ""}</p>
            </div>
          </div>
          {result.demandTraces?.length ? <div className="space-y-2">{result.demandTraces.map((trace, index) => <Trace key={`d-${trace.fileId}-${trace.sourceRow}-${index}`} trace={trace} />)}</div> : null}
          {result.supplyTraces?.length ? <div className="space-y-2">{result.supplyTraces.map((trace, index) => <Trace key={`s-${trace.fileId}-${trace.sourceRow}-${index}`} trace={trace} />)}</div> : null}
          {result.allocations?.length ? (
            <div>
              <p className="font-bold text-slate-800">{text.card.allocations}</p>
              <ul className="mt-2 space-y-2">
                {result.allocations.map((allocation, index) => (
                  <li key={`${allocation.lotKey}-${index}`} className="rounded-md border border-slate-200 bg-white p-2.5">
                    <p className="break-all font-semibold text-slate-800">{allocation.lotKey}</p>
                    <p className="mt-1">{text.card.allocated}: {valueOrDash(allocation.allocatedQty, locale)} · reserved: {valueOrDash(allocation.reservedQty, locale)} · remaining: {valueOrDash(allocation.remainingQty, locale)}</p>
                    {allocation.supply ? <div className="mt-2"><Trace trace={allocation.supply} /></div> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {onReview && result.id ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2" aria-label={text.review.title}>
          <button
            type="button"
            disabled={reviewing}
            aria-pressed={reviewStatus === "approved"}
            onClick={() => void onReview("approved")}
            className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-emerald-300 px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
          >
            {reviewing ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}{text.review.approve}
          </button>
          <button
            type="button"
            disabled={reviewing}
            aria-pressed={reviewStatus === "rejected"}
            onClick={() => void onReview("rejected")}
            className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 px-3 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:opacity-50"
          >
            {reviewing ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <X className="h-4 w-4" aria-hidden="true" />}{text.review.reject}
          </button>
        </div>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          aria-expanded={showSource}
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
