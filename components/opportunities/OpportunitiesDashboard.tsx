"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import OpportunityFilters, { type OpportunityFilterState } from "@/components/opportunities/OpportunityFilters";
import OpportunityTable from "@/components/opportunities/OpportunityTable";
import { EMPTY_OPPORTUNITIES_RESULT } from "@/components/opportunities/opportunity-ui";
import type { SalesOpportunitiesWithConfidenceResult } from "@/lib/opportunities/quality";

const EMPTY_FILTERS: OpportunityFilterState = {
  q: "",
  customer: "",
  partner: "",
  opportunityType: "",
  confidence: "",
  uploadBatchId: ""
};

export default function OpportunitiesDashboard({
  endpoint = "/api/opportunities",
  showHeader = true,
  compact = false
}: {
  endpoint?: string;
  showHeader?: boolean;
  compact?: boolean;
}) {
  const { t } = useLanguage();
  const [result, setResult] = useState<SalesOpportunitiesWithConfidenceResult>(EMPTY_OPPORTUNITIES_RESULT);
  const [filters, setFilters] = useState<OpportunityFilterState>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const uploadOptions = useMemo(() => {
    const uploads = new Map<string, string>();
    for (const item of result.items) {
      for (const upload of item.sourceUploads) {
        uploads.set(upload.uploadBatchId, upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId);
      }
    }
    return Array.from(uploads.entries());
  }, [result.items]);

  async function loadData(next = filters) {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (next.q.trim()) params.set("q", next.q.trim());
    if (next.customer.trim()) params.set("customer", next.customer.trim());
    if (next.partner.trim()) {
      params.set("supplier", next.partner.trim());
      params.set("manufacturer", next.partner.trim());
    }
    if (next.opportunityType) params.set("opportunityType", next.opportunityType);
    if (next.confidence) params.set("confidence", next.confidence);
    if (next.uploadBatchId) params.set("uploadBatchId", next.uploadBatchId);
    params.set("limit", "200");

    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await fetch(`${endpoint}${separator}${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      setResult(await response.json() as SalesOpportunitiesWithConfidenceResult);
    } catch {
      setError(t("opportunities.error"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData(EMPTY_FILTERS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const cards = [
    [t("opportunities.metrics.total"), result.totals.totalOpportunities],
    [t("opportunities.metrics.immediate"), result.totals.immediateSale],
    [t("opportunities.metrics.partial"), result.totals.partialSale],
    [t("opportunities.metrics.excess"), result.totals.excessResale],
    [t("opportunities.metrics.sourcing"), result.totals.sourcingNeeded],
    [t("opportunities.metrics.stockWithoutDemand"), result.totals.stockWithoutDemand],
    [t("opportunities.metrics.highConfidence"), `${result.totals.highConfidence}${result.meta.confidenceTruncated ? "+" : ""}`]
  ] as const;

  return (
    <div className="space-y-5">
      {showHeader ? (
        <div>
          <p className="text-sm font-medium text-brand-700">{t("opportunities.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("opportunities.title")}</h1>
          <p className="text-sm text-slate-500">{t("opportunities.description")}</p>
        </div>
      ) : null}
      <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${compact ? "xl:grid-cols-4" : "xl:grid-cols-7"}`}>
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
            <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <OpportunityFilters value={filters} onChange={setFilters} onApply={() => void loadData()} uploadOptions={uploadOptions} loading={loading} />
      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      <OpportunityTable items={result.items} loading={loading} />
    </div>
  );
}
