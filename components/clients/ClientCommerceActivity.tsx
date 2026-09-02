"use client";

import { useEffect, useState } from "react";
import { ReceiptText } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { parseClientCommerceActivity, type ClientCommerceActivity as Activity } from "@/lib/commerce/ui-model";

async function defaultLoad(clientId: string, signal: AbortSignal) {
  const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/commerce`, {
    cache: "no-store",
    credentials: "same-origin",
    signal
  });
  if (response.status === 403 || response.status === 404) return { recentRfqs: [], recentQuotes: [] };
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

const COPY = {
  es: { title: "Cotizaciones recientes", loading: "Cargando…", error: "No fue posible cargar la actividad comercial.", empty: "No hay cotizaciones recientes." },
  en: { title: "Recent Quotes", loading: "Loading…", error: "Commercial activity could not be loaded.", empty: "No recent quotes are available." },
  zh: { title: "最近报价", loading: "加载中…", error: "无法加载商业活动。", empty: "暂无最近报价。" }
} as const;

const STATUS = {
  es: { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida" },
  en: { draft: "Draft", sent: "Sent", accepted: "Accepted", rejected: "Rejected", expired: "Expired" },
  zh: { draft: "草稿", sent: "已发送", accepted: "已接受", rejected: "已拒绝", expired: "已过期" }
} as const;

export default function ClientCommerceActivity({
  clientId,
  load = defaultLoad
}: {
  clientId: string;
  load?: (clientId: string, signal: AbortSignal) => Promise<Activity>;
}) {
  const { language, locale } = useLanguage();
  const copy = COPY[language];
  const [quotes, setQuotes] = useState<Activity["recentQuotes"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void load(clientId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setQuotes(next.recentQuotes.slice(0, 5));
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
    <section data-testid="client-commerce-activity">
      <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-4 py-3">
          <h2 className="flex items-center gap-2 font-semibold text-slate-950">
            <ReceiptText className="h-4 w-4 text-brand-700" aria-hidden="true" />
            {copy.title}
          </h2>
        </header>
        {loading ? <p className="p-5 text-sm text-slate-500">{copy.loading}</p> : null}
        {!loading && error ? <p className="p-5 text-sm text-red-700">{copy.error}</p> : null}
        {!loading && !error && !quotes.length ? <p className="p-5 text-sm text-slate-500">{copy.empty}</p> : null}
        {!loading && !error && quotes.length ? (
          <div className="divide-y divide-slate-100">
            {quotes.map((quote) => (
              <div key={quote.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-bold text-slate-950">{quote.number}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                      {STATUS[language][quote.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{formatDate(quote.createdAt, locale)} · {quote.sellerName || "—"}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-slate-900">{money(quote.total, locale)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </article>
    </section>
  );
}
