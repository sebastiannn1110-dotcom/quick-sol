"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, FileText, ReceiptText } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import RfqStatusChip from "@/components/commerce/RfqStatusChip";
import { commerceCopy, quoteStatusLabel } from "@/lib/commerce/ui-i18n";
import { parseClientCommerceActivity, type ClientCommerceActivity as Activity } from "@/lib/commerce/ui-model";

async function defaultLoad(clientId: string, signal: AbortSignal) {
  const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/commerce`, {
    cache: "no-store",
    credentials: "same-origin",
    signal
  });
  if (response.status === 403 || response.status === 404) {
    return { recentRfqs: [], recentQuotes: [] };
  }
  if (!response.ok) throw new Error("Commerce activity unavailable.");
  return parseClientCommerceActivity(await response.json());
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function money(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
}

export default function ClientCommerceActivity({
  clientId,
  load = defaultLoad
}: {
  clientId: string;
  load?: (clientId: string, signal: AbortSignal) => Promise<Activity>;
}) {
  const { language, locale } = useLanguage();
  const copy = commerceCopy(language);
  const [activity, setActivity] = useState<Activity>({ recentRfqs: [], recentQuotes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void load(clientId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setActivity({ recentRfqs: next.recentRfqs.slice(0, 5), recentQuotes: next.recentQuotes.slice(0, 5) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clientId, load]);

  return (
    <section className="grid gap-4 lg:grid-cols-2" data-testid="client-commerce-activity">
      <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="flex items-center gap-2 font-semibold text-slate-950"><FileText className="h-4 w-4 text-brand-700" />{copy.recentRfqs}</h2>
          <Link href="/admin/rfqs" className="text-xs font-semibold text-brand-700 hover:underline">{copy.viewAllRfqs}</Link>
        </header>
        {loading ? <p className="p-5 text-sm text-slate-500">{copy.loading}</p> : error ? <p className="p-5 text-sm text-red-700">{copy.loadError}</p> : !activity.recentRfqs.length ? <p className="p-5 text-sm text-slate-500">{copy.noRecentRfqs}</p> : (
          <div className="divide-y divide-slate-100">
            {activity.recentRfqs.map((rfq) => (
              <Link key={rfq.id} href={`/admin/rfqs/${encodeURIComponent(rfq.id)}`} className="flex items-center justify-between gap-3 p-4 hover:bg-slate-50">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate font-mono text-sm font-bold text-slate-950">{rfq.primaryMpn || "—"}</p><RfqStatusChip status={rfq.status} language={language} /></div><p className="mt-1 text-xs text-slate-500">{formatDate(rfq.createdAt, locale)} · {copy.qty} {rfq.primaryQuantity || "—"}</p></div><ArrowRight className="h-4 w-4 shrink-0 text-slate-400" />
              </Link>
            ))}
          </div>
        )}
      </article>

      <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-4 py-3"><h2 className="flex items-center gap-2 font-semibold text-slate-950"><ReceiptText className="h-4 w-4 text-brand-700" />{copy.recentQuotes}</h2></header>
        {loading ? <p className="p-5 text-sm text-slate-500">{copy.loading}</p> : error ? <p className="p-5 text-sm text-red-700">{copy.loadError}</p> : !activity.recentQuotes.length ? <p className="p-5 text-sm text-slate-500">{copy.noRecentQuotes}</p> : (
          <div className="divide-y divide-slate-100">
            {activity.recentQuotes.map((quote) => (
              <Link key={quote.id} href={`/admin/quotes/${encodeURIComponent(quote.id)}`} className="flex items-center justify-between gap-3 p-4 hover:bg-slate-50">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-bold text-slate-950">{quote.number}</p><span className="text-[10px] font-bold text-slate-500">{quoteStatusLabel(quote.status, language)}</span></div><p className="mt-1 text-xs text-slate-500">{formatDate(quote.createdAt, locale)} · {quote.sellerName || "—"}</p></div><div className="flex shrink-0 items-center gap-2"><span className="text-sm font-semibold text-slate-900">{money(quote.total, locale)}</span><ArrowRight className="h-4 w-4 text-slate-400" /></div>
              </Link>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
