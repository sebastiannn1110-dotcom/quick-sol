"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import OpportunityFilters, { type OpportunityFilterState } from "@/components/opportunities/OpportunityFilters";
import OpportunityTable from "@/components/opportunities/OpportunityTable";
import { EMPTY_OPPORTUNITIES_RESULT } from "@/components/opportunities/opportunity-ui";
import {
  parseSummaryUnavailablePayload,
  requestBusinessSummaryRebuildFromUi,
  type SummaryUnavailablePayload
} from "@/lib/performance/summary-readiness";
import { isExpectedAbort } from "@/lib/request-lifecycle";
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
  compact = false,
  summaryScope = {}
}: {
  endpoint?: string;
  showHeader?: boolean;
  compact?: boolean;
  summaryScope?: { clientId?: string | null; uploadBatchId?: string | null };
}) {
  const { t } = useLanguage();
  const [result, setResult] = useState<SalesOpportunitiesWithConfidenceResult | null>(null);
  const [filters, setFilters] = useState<OpportunityFilterState>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [summaryUnavailable, setSummaryUnavailable] = useState<SummaryUnavailablePayload | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const rebuildRequestRef = useRef<AbortController | null>(null);

  const uploadOptions = useMemo(() => {
    const uploads = new Map<string, string>();
    for (const item of result?.items ?? []) {
      for (const upload of item.sourceUploads) {
        uploads.set(upload.uploadBatchId, upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId);
      }
    }
    return Array.from(uploads.entries());
  }, [result]);

  async function loadData(next = filters) {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setSummaryUnavailable(null);
    setResult(null);
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
      const response = await fetch(`${endpoint}${separator}${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const lifecycle = parseSummaryUnavailablePayload(payload);
        if (lifecycle) {
          setSummaryUnavailable(lifecycle);
          return;
        }
        throw new Error("OPPORTUNITIES_LOAD_FAILED");
      }
      setResult(payload as SalesOpportunitiesWithConfidenceResult);
    } catch (loadError) {
      if (!isExpectedAbort(loadError, controller.signal)) setError(t("opportunities.error"));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  async function retrySummary() {
    if (!summaryUnavailable || loading || rebuildRequestRef.current) return;
    if (summaryUnavailable.summaryStatus !== "failed") {
      await loadData();
      return;
    }
    const controller = new AbortController();
    rebuildRequestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      await requestBusinessSummaryRebuildFromUi({
        ...summaryScope,
        uploadBatchId: filters.uploadBatchId || summaryScope.uploadBatchId || null
      }, controller.signal);
      if (!controller.signal.aborted) await loadData();
    } catch (rebuildError) {
      if (!isExpectedAbort(rebuildError, controller.signal)) {
        setError(t("opportunities.error"));
        setLoading(false);
      }
    } finally {
      if (rebuildRequestRef.current === controller) rebuildRequestRef.current = null;
    }
  }

  useEffect(() => {
    void loadData(EMPTY_FILTERS);
    return () => {
      requestRef.current?.abort();
      rebuildRequestRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const cards = [
    [t("opportunities.metrics.total"), result?.totals.totalOpportunities ?? null],
    [t("opportunities.metrics.immediate"), result?.totals.immediateSale ?? null],
    [t("opportunities.metrics.partial"), result?.totals.partialSale ?? null],
    [t("opportunities.metrics.excess"), result?.totals.excessResale ?? null],
    [t("opportunities.metrics.sourcing"), result?.totals.sourcingNeeded ?? null],
    [t("opportunities.metrics.stockWithoutDemand"), result?.totals.stockWithoutDemand ?? null],
    [t("opportunities.metrics.highConfidence"), result ? `${result.totals.highConfidence}${result.meta.confidenceTruncated ? "+" : ""}` : null]
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
            <p className="mt-2 text-xl font-semibold text-slate-950">
              {loading ? <span className="inline-block h-6 w-12 animate-pulse rounded bg-slate-200" aria-label={t("summary.loading")} /> : value ?? "—"}
            </p>
          </div>
        ))}
      </div>
      <OpportunityFilters value={filters} onChange={setFilters} onApply={() => void loadData()} uploadOptions={uploadOptions} loading={loading} />
      {summaryUnavailable ? (
        <div className={`rounded-md border p-4 text-sm ${summaryUnavailable.summaryStatus === "failed" || summaryUnavailable.summaryStatus === "contract_unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800"}`} role="status">
          <p>{summaryUnavailable.summaryStatus === "failed"
            ? t("summary.failed")
            : summaryUnavailable.summaryStatus === "contract_unavailable"
              ? t("summary.contractUnavailable")
              : t("summary.updating")}</p>
          {summaryUnavailable.retryable ? (
            <button type="button" className="mt-3 rounded-md border border-current px-3 py-2 font-semibold" onClick={() => void retrySummary()} disabled={loading}>
              {t("summary.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}
      {error ? (
        <button type="button" className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={() => void loadData()} disabled={loading}>
          {t("summary.retry")}
        </button>
      ) : null}
      {loading || result ? <OpportunityTable items={result?.items ?? EMPTY_OPPORTUNITIES_RESULT.items} loading={loading} /> : null}
    </div>
  );
}
