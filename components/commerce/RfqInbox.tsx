"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ArrowRight, FileText, RefreshCw } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { useVisiblePolling } from "@/components/useVisiblePolling";
import RfqStatusChip from "@/components/commerce/RfqStatusChip";
import { DemoAccountBadge } from "@/components/clients/DemoAccount";
import { commerceRequest } from "@/lib/commerce/client";
import { commerceCopy } from "@/lib/commerce/ui-i18n";
import {
  isUiNewRfq,
  parseRfqListPayload,
  type CommerceRfqSummary
} from "@/lib/commerce/ui-model";

type InboxData = { rfqs: CommerceRfqSummary[]; pendingCount: number };

async function defaultLoad(signal: AbortSignal): Promise<InboxData> {
  return parseRfqListPayload(await commerceRequest<unknown>("/api/commerce/rfqs?limit=100", { signal }));
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function RfqInbox({
  load = defaultLoad
}: {
  load?: (signal: AbortSignal) => Promise<InboxData>;
}) {
  const { language, locale } = useLanguage();
  const copy = commerceCopy(language);
  const [data, setData] = useState<InboxData>({ rfqs: [], pendingCount: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const poll = useCallback(async ({ signal, trigger }: { signal: AbortSignal; trigger: string }) => {
    if (trigger === "manual") setRefreshing(true);
    try {
      const next = await load(signal);
      if (!signal.aborted) {
        setData(next);
        setError("");
      }
    } catch {
      if (!signal.aborted) setError(copy.loadError);
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [copy.loadError, load]);
  const { refresh } = useVisiblePolling(poll, { intervalMs: 12_000 });
  const rfqs = useMemo(
    () => [...data.rfqs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [data.rfqs]
  );

  return (
    <div className="space-y-5" data-testid="rfq-inbox">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">{copy.rfqInboxEyebrow}</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-950 sm:text-3xl">{copy.rfqInbox}</h1>
            {data.pendingCount > 0 ? (
              <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-bold text-orange-800">
                {data.pendingCount} {copy.pending}
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">{copy.rfqInboxHelp}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? copy.refreshing : copy.refresh}
        </button>
      </header>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <span>{error}</span>
          <button type="button" className="font-semibold underline" onClick={() => void refresh()}>{copy.retry}</button>
        </div>
      ) : null}

      {loading ? (
        <div className="grid min-h-52 place-items-center rounded-xl border border-slate-200 bg-white text-sm text-slate-500">
          {copy.loading}
        </div>
      ) : !rfqs.length ? (
        <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <div>
            <FileText className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 text-sm font-medium text-slate-600">{copy.noRfqs}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:block">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">{copy.status}</th>
                    <th className="px-4 py-3 font-semibold">{copy.date}</th>
                    <th className="px-4 py-3 font-semibold">{copy.company}</th>
                    <th className="px-4 py-3 font-semibold">{copy.products}</th>
                    <th className="px-4 py-3 font-semibold">{copy.country}</th>
                    <th className="px-4 py-3 font-semibold">{copy.seller}</th>
                    <th className="px-4 py-3 font-semibold">{copy.source}</th>
                    <th className="px-4 py-3"><span className="sr-only">{copy.open}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rfqs.map((rfq) => {
                    const isNew = isUiNewRfq(rfq);
                    return (
                      <tr key={rfq.id} className="transition hover:bg-slate-50/80">
                        <td className="px-4 py-4 align-top">
                          <div className="flex flex-wrap gap-1.5">
                            <RfqStatusChip status={rfq.status} language={language} />
                            {isNew ? <RfqStatusChip status={rfq.status} language={language} isNew /> : null}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 align-top text-xs text-slate-600">{formatDate(rfq.createdAt, locale)}</td>
                        <td className="max-w-56 px-4 py-4 align-top">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="font-semibold text-slate-950">{rfq.companyOrName || "—"}</p>
                            <DemoAccountBadge accountName={rfq.companyOrName} />
                          </div>
                          <p className="mt-1 truncate text-xs text-slate-500">{rfq.contactName || "—"}</p>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <p className="font-mono text-sm font-semibold text-slate-950">{rfq.primaryMpn || "—"}</p>
                          <p className="mt-1 text-xs text-slate-500">{copy.qty} {rfq.primaryQuantity || "—"} · {rfq.itemCount} {copy.lines.toLowerCase()}</p>
                        </td>
                        <td className="px-4 py-4 align-top text-slate-700">{rfq.country || "—"}</td>
                        <td className="px-4 py-4 align-top text-slate-700">{rfq.assignedSeller?.fullName || copy.unassignedSeller}</td>
                        <td className="max-w-52 px-4 py-4 align-top">
                          <p className="text-xs font-medium text-slate-700">{rfq.source}</p>
                          <p className="mt-1 truncate font-mono text-[11px] text-slate-400" title={rfq.externalRfqId}>{rfq.externalRfqId || "—"}</p>
                        </td>
                        <td className="px-4 py-4 text-right align-top">
                          <Link href={`/admin/rfqs/${encodeURIComponent(rfq.id)}`} className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50">
                            {copy.open}<ArrowRight className="h-4 w-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
            {rfqs.map((rfq) => {
              const isNew = isUiNewRfq(rfq);
              return (
                <article key={rfq.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <RfqStatusChip status={rfq.status} language={language} />
                      {isNew ? <RfqStatusChip status={rfq.status} language={language} isNew /> : null}
                      <DemoAccountBadge accountName={rfq.companyOrName} />
                    </div>
                    <time className="text-right text-[11px] text-slate-500">{formatDate(rfq.createdAt, locale)}</time>
                  </div>
                  <h2 className="mt-3 break-words text-lg font-semibold text-slate-950">{rfq.companyOrName || "—"}</h2>
                  <p className="mt-1 text-xs text-slate-500">{rfq.contactName || "—"} · {rfq.country || "—"}</p>
                  <div className="mt-4 rounded-lg bg-slate-50 p-3">
                    <p className="font-mono text-sm font-bold text-slate-950">{rfq.primaryMpn || "—"}</p>
                    <p className="mt-1 text-xs text-slate-600">{copy.qty} {rfq.primaryQuantity || "—"} · {rfq.itemCount} {copy.lines.toLowerCase()}</p>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div><dt className="text-slate-500">{copy.seller}</dt><dd className="mt-1 font-medium text-slate-800">{rfq.assignedSeller?.fullName || copy.unassignedSeller}</dd></div>
                    <div><dt className="text-slate-500">{copy.source}</dt><dd className="mt-1 font-medium text-slate-800">{rfq.source}</dd></div>
                  </dl>
                  <p className="mt-3 truncate font-mono text-[10px] text-slate-400">{rfq.externalRfqId || "—"}</p>
                  <Link href={`/admin/rfqs/${encodeURIComponent(rfq.id)}`} className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
                    {copy.open}<ArrowRight className="h-4 w-4" />
                  </Link>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
