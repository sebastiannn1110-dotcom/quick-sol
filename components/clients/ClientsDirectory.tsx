"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ClientGrid from "@/components/clients/ClientGrid";
import { useLanguage } from "@/components/LanguageProvider";
import { useProfile } from "@/components/ProfileProvider";
import type { AccountClient } from "@/lib/clients/clients";
import type { SalesOpportunitiesWithConfidenceResult } from "@/lib/opportunities/quality";
import {
  parseSummaryUnavailablePayload,
  requestBusinessSummaryRebuildFromUi,
  type SummaryReadState,
  type SummaryUnavailablePayload
} from "@/lib/performance/summary-readiness";
import { isExpectedAbort } from "@/lib/request-lifecycle";
import { canManageClients } from "@/lib/security/permissions";

export default function ClientsDirectory({ adminMode = false }: { adminMode?: boolean }) {
  const { t } = useLanguage();
  const [clients, setClients] = useState<AccountClient[]>([]);
  const [opportunities, setOpportunities] = useState<Pick<SalesOpportunitiesWithConfidenceResult, "totals"> | null>(null);
  const [clientSummary, setClientSummary] = useState<SummaryReadState | null>(null);
  const [opportunitySummaryUnavailable, setOpportunitySummaryUnavailable] = useState<SummaryUnavailablePayload | null>(null);
  const { profile } = useProfile();
  const [loading, setLoading] = useState(true);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(!adminMode);
  const [error, setError] = useState("");
  const [opportunitiesError, setOpportunitiesError] = useState("");
  const [clientsRefreshKey, setClientsRefreshKey] = useState(0);
  const [opportunitiesRefreshKey, setOpportunitiesRefreshKey] = useState(0);
  const [summaryRetrying, setSummaryRetrying] = useState(false);
  const rebuildRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const clientsResponse = await fetch(`/api/clients${adminMode ? "?includeArchived=true" : ""}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!clientsResponse.ok) throw new Error();
        const payload = await clientsResponse.json() as { clients: AccountClient[]; summary?: SummaryReadState };
        setClients(payload.clients);
        setClientSummary(payload.summary ?? null);
      } catch (loadError) {
        if (!isExpectedAbort(loadError, controller.signal)) setError(t("clients.error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [adminMode, clientsRefreshKey, t]);

  useEffect(() => {
    if (adminMode) return;
    const controller = new AbortController();
    async function loadSummary() {
      setOpportunitiesLoading(true);
      setOpportunities(null);
      setOpportunitiesError("");
      setOpportunitySummaryUnavailable(null);
      try {
        const response = await fetch("/api/opportunities/summary", {
          cache: "no-store",
          signal: controller.signal
        });
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const lifecycle = parseSummaryUnavailablePayload(payload);
          if (lifecycle) {
            setOpportunitySummaryUnavailable(lifecycle);
            return;
          }
          throw new Error("OPPORTUNITIES_SUMMARY_FAILED");
        }
        setOpportunities(payload as Pick<SalesOpportunitiesWithConfidenceResult, "totals">);
      } catch (loadError) {
        if (!isExpectedAbort(loadError, controller.signal)) {
          setOpportunitiesError(t("opportunities.error"));
        }
      } finally {
        if (!controller.signal.aborted) setOpportunitiesLoading(false);
      }
    }
    void loadSummary();
    return () => controller.abort();
  }, [adminMode, opportunitiesRefreshKey, t]);

  useEffect(() => () => rebuildRequestRef.current?.abort(), []);

  async function retrySummary(input: {
    state: SummaryReadState;
    refresh: () => void;
    failureMessage: string;
  }) {
    if (summaryRetrying || rebuildRequestRef.current) return;
    if (input.state.status !== "failed") {
      input.refresh();
      return;
    }
    const controller = new AbortController();
    rebuildRequestRef.current = controller;
    setSummaryRetrying(true);
    try {
      await requestBusinessSummaryRebuildFromUi({}, controller.signal);
      if (!controller.signal.aborted) input.refresh();
    } catch (rebuildError) {
      if (!isExpectedAbort(rebuildError, controller.signal)) {
        if (input.state === clientSummary) setError(input.failureMessage);
        else setOpportunitiesError(input.failureMessage);
      }
    } finally {
      if (rebuildRequestRef.current === controller) rebuildRequestRef.current = null;
      if (!controller.signal.aborted) setSummaryRetrying(false);
    }
  }

  const canManage = profile ? canManageClients(profile.role) : false;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-700">{t("clients.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("clients.title")}</h1>
        </div>
        {canManage ? (
          <Link href="/admin/clients/new" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            <Plus className="h-4 w-4" />
            {t("clients.create")}
          </Link>
        ) : null}
      </div>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{error}</p>
          <button type="button" className="mt-3 rounded-md border border-current px-3 py-2 font-semibold" onClick={() => setClientsRefreshKey((value) => value + 1)}>{t("summary.retry")}</button>
        </div>
      ) : null}
      {!adminMode ? (
        <section className="space-y-4 border-y border-slate-200 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-slate-950">{t("clients.opportunitiesTitle")}</h2>
            <Link href="/opportunities" className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
              {t("clients.viewAllOpportunities")}
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [t("opportunities.metrics.total"), opportunities?.totals.totalOpportunities ?? null],
              [t("opportunities.metrics.immediate"), opportunities?.totals.immediateSale ?? null],
              [t("opportunities.metrics.partial"), opportunities?.totals.partialSale ?? null],
              [t("opportunities.metrics.sourcing"), opportunities?.totals.sourcingNeeded ?? null]
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">
                  {opportunitiesLoading ? <span className="inline-block h-6 w-12 animate-pulse rounded bg-slate-200" aria-label={t("summary.loading")} /> : value ?? "—"}
                </p>
              </div>
            ))}
          </div>
          {opportunitySummaryUnavailable ? (
            <div className={`rounded-md border p-4 text-sm ${opportunitySummaryUnavailable.summaryStatus === "failed" || opportunitySummaryUnavailable.summaryStatus === "contract_unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800"}`} role="status">
              <p>{opportunitySummaryUnavailable.summaryStatus === "failed"
                ? t("summary.failed")
                : opportunitySummaryUnavailable.summaryStatus === "contract_unavailable"
                  ? t("summary.contractUnavailable")
                  : t("summary.updating")}</p>
              {opportunitySummaryUnavailable.retryable ? (
                <button type="button" disabled={summaryRetrying} className="mt-3 rounded-md border border-current px-3 py-2 font-semibold disabled:opacity-50" onClick={() => void retrySummary({
                  state: opportunitySummaryUnavailable,
                  refresh: () => setOpportunitiesRefreshKey((value) => value + 1),
                  failureMessage: t("opportunities.error")
                })}>{t("summary.retry")}</button>
              ) : null}
            </div>
          ) : null}
          {opportunitiesError ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <p>{opportunitiesError}</p>
              <button type="button" className="mt-3 rounded-md border border-current px-3 py-2 font-semibold" onClick={() => setOpportunitiesRefreshKey((value) => value + 1)}>{t("summary.retry")}</button>
            </div>
          ) : null}
        </section>
      ) : null}
      {clientSummary && clientSummary.status !== "ready" ? (
        <div className={`rounded-md border p-4 text-sm ${clientSummary.status === "failed" || clientSummary.status === "contract_unavailable" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800"}`} role="status">
          <p>{clientSummary.status === "failed"
            ? t("summary.failed")
            : clientSummary.status === "contract_unavailable"
              ? t("summary.contractUnavailable")
              : t("summary.updating")}</p>
          {clientSummary.retryable ? (
            <button type="button" disabled={summaryRetrying} className="mt-3 rounded-md border border-current px-3 py-2 font-semibold disabled:opacity-50" onClick={() => void retrySummary({
              state: clientSummary,
              refresh: () => setClientsRefreshKey((value) => value + 1),
              failureMessage: t("clients.error")
            })}>{t("summary.retry")}</button>
          ) : null}
        </div>
      ) : null}
      <ClientGrid clients={clients} loading={loading} canManage={canManage} />
    </div>
  );
}
