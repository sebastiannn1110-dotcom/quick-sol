"use client";

import { RefreshCw, Search } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { OpportunityType } from "@/lib/opportunities/opportunities";
import type { OpportunityConfidenceLabel } from "@/lib/opportunities/quality";

export type OpportunityFilterState = {
  q: string;
  customer: string;
  partner: string;
  opportunityType: "" | OpportunityType;
  confidence: "" | OpportunityConfidenceLabel;
  uploadBatchId: string;
};

export default function OpportunityFilters({
  value,
  onChange,
  onApply,
  uploadOptions,
  loading
}: {
  value: OpportunityFilterState;
  onChange: (next: OpportunityFilterState) => void;
  onApply: () => void;
  uploadOptions: Array<[string, string]>;
  loading: boolean;
}) {
  const { t } = useLanguage();
  const typeOptions: Array<{ value: "" | OpportunityType; label: string }> = [
    { value: "", label: t("opportunities.type.all") },
    { value: "immediate_sale", label: t("opportunities.type.immediate") },
    { value: "partial_sale", label: t("opportunities.type.partial") },
    { value: "excess_resale", label: t("opportunities.type.excess") },
    { value: "sourcing_needed", label: t("opportunities.type.sourcing") },
    { value: "stock_without_demand", label: t("opportunities.type.stockWithoutDemand") }
  ];
  const confidenceOptions: Array<{ value: "" | OpportunityConfidenceLabel; label: string }> = [
    { value: "", label: t("opportunities.confidence.all") },
    { value: "high", label: t("opportunities.confidence.high") },
    { value: "medium", label: t("opportunities.confidence.medium") },
    { value: "low", label: t("opportunities.confidence.low") }
  ];
  return (
    <form
      className="grid gap-3 border-y border-slate-200 bg-white py-4 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.mpn")}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={value.q}
            onChange={(event) => onChange({ ...value, q: event.target.value })}
            className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 font-normal"
            placeholder="001234, 1748917, ABC-001"
          />
        </div>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.customer")}
        <input value={value.customer} onChange={(event) => onChange({ ...value, customer: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.partner")}
        <input value={value.partner} onChange={(event) => onChange({ ...value, partner: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.type")}
        <select value={value.opportunityType} onChange={(event) => onChange({ ...value, opportunityType: event.target.value as "" | OpportunityType })} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
          {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.confidence")}
        <select value={value.confidence} onChange={(event) => onChange({ ...value, confidence: event.target.value as "" | OpportunityConfidenceLabel })} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
          {confidenceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-700">
        {t("opportunities.filters.upload")}
        <select value={value.uploadBatchId} onChange={(event) => onChange({ ...value, uploadBatchId: event.target.value })} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
          <option value="">{t("opportunities.filters.allUploads")}</option>
          {uploadOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <button type="submit" className="inline-flex h-11 w-full items-center justify-center gap-2 self-end rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        {t("opportunities.filters.apply")}
      </button>
    </form>
  );
}
