"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, FileText, Link2, Send, Save } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { DemoAccountBadge, DemoAccountNotice } from "@/components/clients/DemoAccount";
import { CommerceApiError, commerceRequest } from "@/lib/commerce/client";
import { commerceCopy, quoteStatusLabel } from "@/lib/commerce/ui-i18n";
import { normalizeCommerceQuote, type CommerceQuoteItemUi, type CommerceQuoteUi } from "@/lib/commerce/ui-model";

type QuoteForm = {
  validUntil: string;
  notes: string;
  commercialTerms: string;
  taxRate: number;
  items: Array<{ productId: string | null; quantity: number; discountPercent: number }>;
};

async function defaultLoad(quoteId: string, signal?: AbortSignal) {
  return normalizeCommerceQuote(await commerceRequest<unknown>(`/api/commerce/quotes/${encodeURIComponent(quoteId)}`, { signal }));
}

async function defaultSave(quote: CommerceQuoteUi, form: QuoteForm) {
  return normalizeCommerceQuote(await commerceRequest<unknown>(`/api/commerce/quotes/${encodeURIComponent(quote.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      version: quote.version,
      customerId: quote.customer.id,
      rfqId: quote.rfqId,
      ...form
    })
  }));
}

async function defaultSend(quote: CommerceQuoteUi) {
  return normalizeCommerceQuote(await commerceRequest<unknown>(`/api/commerce/quotes/${encodeURIComponent(quote.id)}/send`, {
    method: "POST",
    body: JSON.stringify({ version: quote.version })
  }));
}

async function defaultShare(quoteId: string) {
  return commerceRequest<{ shareUrl: string; expiresAt: string }>(`/api/commerce/quotes/${encodeURIComponent(quoteId)}/share`, {
    method: "POST",
    body: JSON.stringify({ expiresInHours: 72 })
  });
}

function formFromQuote(quote: CommerceQuoteUi): QuoteForm {
  return {
    validUntil: quote.validUntil,
    notes: quote.notes,
    commercialTerms: quote.commercialTerms,
    taxRate: quote.taxRate,
    items: quote.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      discountPercent: item.discountPercent
    }))
  };
}

function money(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
}

function unitMoney(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  }).format(value);
}

function roundTo(value: number, decimals: number) {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function calculateQuotePreview(
  items: Array<Pick<CommerceQuoteItemUi, "authorizedUnitPrice" | "quantity" | "discountPercent">>,
  formItems: Array<{ quantity: number; discountPercent: number }>,
  taxRate: number
) {
  const sellerUnitPrices = items.map((item, index) => {
    const input = formItems[index] ?? item;
    return roundTo(item.authorizedUnitPrice * (1 - input.discountPercent / 100), 4);
  });
  const lines = items.map((item, index) => {
    const input = formItems[index] ?? item;
    return roundTo(sellerUnitPrices[index] * input.quantity, 2);
  });
  const subtotal = roundTo(lines.reduce((sum, value) => sum + value, 0), 2);
  const tax = roundTo(subtotal * taxRate / 100, 2);
  return { sellerUnitPrices, lines, subtotal, tax, total: roundTo(subtotal + tax, 2) };
}

function statusStyle(status: CommerceQuoteUi["status"]) {
  if (status === "accepted") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "sent") return "border-sky-200 bg-sky-50 text-sky-800";
  if (status === "rejected") return "border-red-200 bg-red-50 text-red-800";
  if (status === "expired") return "border-slate-200 bg-slate-100 text-slate-600";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export default function QuoteEditor({
  quoteId,
  load = defaultLoad,
  save = defaultSave,
  send = defaultSend,
  share = defaultShare
}: {
  quoteId: string;
  load?: (quoteId: string, signal?: AbortSignal) => Promise<CommerceQuoteUi>;
  save?: (quote: CommerceQuoteUi, form: QuoteForm) => Promise<CommerceQuoteUi>;
  send?: (quote: CommerceQuoteUi) => Promise<CommerceQuoteUi>;
  share?: (quoteId: string) => Promise<{ shareUrl: string; expiresAt: string }>;
}) {
  const { language, locale } = useLanguage();
  const copy = commerceCopy(language);
  const [quote, setQuote] = useState<CommerceQuoteUi | null>(null);
  const [form, setForm] = useState<QuoteForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "send" | "share" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const next = await load(quoteId, signal);
      if (!signal?.aborted) {
        setQuote(next);
        setForm(formFromQuote(next));
      }
    } catch {
      if (!signal?.aborted) setError(copy.loadError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [copy.loadError, load, quoteId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const preview = useMemo(() => {
    if (!quote || !form) return { sellerUnitPrices: [] as number[], lines: [] as number[], subtotal: 0, tax: 0, total: 0 };
    return calculateQuotePreview(quote.items, form.items, form.taxRate);
  }, [form, quote]);

  const pricingReady = Boolean(quote?.items.length && quote.items.every((item) => item.productId && item.authorizedUnitPrice > 0));
  const editable = quote?.status === "draft";

  function updateItem(index: number, field: "quantity" | "discountPercent", value: number) {
    setForm((current) => current ? {
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)
    } : current);
    setMessage("");
  }

  async function persistDraft() {
    if (!quote || !form) throw new Error(copy.loadError);
    const next = await save(quote, form);
    setQuote(next);
    setForm(formFromQuote(next));
    return next;
  }

  async function handleSave() {
    setBusy("save");
    setError("");
    setMessage("");
    try {
      await persistDraft();
      setMessage(copy.quoteSaved);
    } catch (saveError) {
      setError(saveError instanceof CommerceApiError ? saveError.message : copy.loadError);
    } finally {
      setBusy(null);
    }
  }

  async function handleSend() {
    if (!quote || !pricingReady) return;
    setBusy("send");
    setError("");
    setMessage("");
    try {
      const saved = await persistDraft();
      const next = await send(saved);
      setQuote(next);
      setForm(formFromQuote(next));
      setMessage(copy.quoteSent);
    } catch (sendError) {
      setError(sendError instanceof CommerceApiError ? sendError.message : copy.loadError);
    } finally {
      setBusy(null);
    }
  }

  async function handleShare() {
    if (!quote) return;
    setBusy("share");
    setError("");
    try {
      const result = await share(quote.id);
      setShareUrl(result.shareUrl);
    } catch (shareError) {
      setError(shareError instanceof CommerceApiError ? shareError.message : copy.loadError);
    } finally {
      setBusy(null);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  if (loading) return <div className="py-16 text-center text-sm text-slate-500">{copy.loading}</div>;
  if (!quote || !form) return <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800"><p>{error || copy.loadError}</p><button type="button" className="mt-3 font-semibold underline" onClick={() => void refresh()}>{copy.retry}</button></div>;

  return (
    <div className="space-y-6" data-testid="quote-editor">
      <Link href={quote.rfqId ? `/admin/rfqs/${encodeURIComponent(quote.rfqId)}` : "/admin/rfqs"} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-950"><ArrowLeft className="h-4 w-4" />{quote.rfqId ? copy.originRfq : copy.backToInbox}</Link>

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-700">{copy.quoteEditor}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-950 sm:text-3xl">{quote.number}</h1>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold tracking-wide ${statusStyle(quote.status)}`}>{quoteStatusLabel(quote.status, language)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{quote.customer.companyOrName}</span>
              <DemoAccountBadge accountName={quote.customer.companyOrName} />
              <span>·</span><span>{quote.sellerName}</span>
            </div>
            <DemoAccountNotice accountName={quote.customer.companyOrName} className="mt-2" />
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg bg-slate-50 px-3 py-2"><dt className="text-slate-500">{copy.quoteNumber}</dt><dd className="mt-1 font-semibold text-slate-900">{quote.number}</dd></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><dt className="text-slate-500">{copy.originRfq}</dt><dd className="mt-1 font-mono font-semibold text-slate-900">{quote.rfqId ? quote.rfqId.slice(0, 8) : "—"}</dd></div>
          </dl>
        </div>
      </header>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">{error}</div> : null}
      {message ? <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800" role="status"><Check className="h-4 w-4" />{message}</div> : null}
      {!pricingReady ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">{copy.pricingRequired}</p><p className="mt-1 text-xs">{copy.sendBlocked}</p></div> : null}
      {!editable ? <div className="rounded-lg border border-slate-200 bg-slate-100 p-4 text-sm text-slate-700">{copy.draftOnly}</div> : null}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4"><h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950"><FileText className="h-5 w-5 text-brand-700" />{copy.products}</h2></div>
        <div className="hidden overflow-x-auto lg:block">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">{copy.mpn}</th><th className="px-4 py-3">{copy.quantity}</th><th className="px-4 py-3">{copy.authorizedUnitPrice}</th><th className="px-4 py-3">{copy.discount}</th><th className="px-4 py-3">{copy.sellerUnitPrice}</th><th className="px-4 py-3 text-right">{copy.lineTotal}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {quote.items.map((item, index) => {
                const input = form.items[index];
                const unit = preview.sellerUnitPrices[index] ?? 0;
                const linePricingReady = Boolean(item.productId && item.authorizedUnitPrice > 0);
                return <tr key={`${item.productId ?? "unresolved"}-${index}`}><td className="px-4 py-4"><p className="font-mono font-bold text-slate-950">{item.mpn}</p><p className="mt-1 max-w-xs truncate text-xs text-slate-500">{item.manufacturer} · {item.description}</p></td><td className="px-4 py-4"><input aria-label={`${copy.quantity} ${item.mpn}`} disabled={!editable} type="number" min="1" max="1000000" value={input.quantity} onChange={(event) => updateItem(index, "quantity", Number(event.target.value))} className="h-10 w-24 rounded-md border border-slate-300 px-3 disabled:bg-slate-50" /></td><td className="px-4 py-4 font-semibold text-slate-900">{linePricingReady ? unitMoney(item.authorizedUnitPrice, locale) : copy.pricingRequired}</td><td className="px-4 py-4"><div className="flex items-center gap-1"><input aria-label={`${copy.discount} ${item.mpn}`} disabled={!editable || !linePricingReady} type="number" min="0" max="100" step="0.01" value={input.discountPercent} onChange={(event) => updateItem(index, "discountPercent", Number(event.target.value))} className="h-10 w-24 rounded-md border border-slate-300 px-3 disabled:bg-slate-50" /><span>%</span></div></td><td className="px-4 py-4 text-slate-700">{linePricingReady ? unitMoney(unit, locale) : copy.pricingRequired}</td><td className="px-4 py-4 text-right font-semibold text-slate-950">{linePricingReady ? money(preview.lines[index] ?? 0, locale) : copy.pricingRequired}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-100 lg:hidden">
          {quote.items.map((item, index) => {
            const input = form.items[index];
            const unit = preview.sellerUnitPrices[index] ?? 0;
            const linePricingReady = Boolean(item.productId && item.authorizedUnitPrice > 0);
            return <article key={`${item.productId ?? "unresolved"}-${index}`} className="p-4"><p className="font-mono font-bold text-slate-950">{item.mpn}</p><p className="mt-1 text-xs text-slate-500">{item.manufacturer} · {item.description}</p><div className="mt-4 grid grid-cols-2 gap-3"><label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.quantity}<input disabled={!editable} type="number" min="1" value={input.quantity} onChange={(event) => updateItem(index, "quantity", Number(event.target.value))} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-50" /></label><label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.discount}<span className="flex items-center"><input disabled={!editable || !linePricingReady} type="number" min="0" max="100" step="0.01" value={input.discountPercent} onChange={(event) => updateItem(index, "discountPercent", Number(event.target.value))} className="h-10 min-w-0 flex-1 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-50" /><span className="ml-1">%</span></span></label></div><dl className="mt-4 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-slate-500">{copy.authorizedUnitPrice}</dt><dd className="mt-1 font-semibold">{linePricingReady ? unitMoney(item.authorizedUnitPrice, locale) : copy.pricingRequired}</dd></div><div><dt className="text-slate-500">{copy.sellerUnitPrice}</dt><dd className="mt-1 font-semibold">{linePricingReady ? unitMoney(unit, locale) : copy.pricingRequired}</dd></div><div><dt className="text-slate-500">{copy.lineTotal}</dt><dd className="mt-1 font-bold">{linePricingReady ? money(preview.lines[index] ?? 0, locale) : copy.pricingRequired}</dd></div></dl></article>;
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-slate-700">{copy.validUntil}<input disabled={!editable} required type="date" value={form.validUntil} onChange={(event) => setForm((current) => current ? { ...current, validUntil: event.target.value } : current)} className="h-11 rounded-md border border-slate-300 px-3 font-normal disabled:bg-slate-50" /></label>
            <label className="grid gap-1 text-sm font-semibold text-slate-700">{copy.taxRate}<span className="flex items-center"><input disabled={!editable} required min="0" max="100" step="0.01" type="number" value={form.taxRate} onChange={(event) => setForm((current) => current ? { ...current, taxRate: Number(event.target.value) } : current)} className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 px-3 font-normal disabled:bg-slate-50" /><span className="ml-2">%</span></span></label>
            <label className="grid gap-1 text-sm font-semibold text-slate-700 sm:col-span-2">{copy.notes}<textarea disabled={!editable} maxLength={2000} value={form.notes} onChange={(event) => setForm((current) => current ? { ...current, notes: event.target.value } : current)} className="min-h-24 rounded-md border border-slate-300 p-3 font-normal disabled:bg-slate-50" /></label>
            <label className="grid gap-1 text-sm font-semibold text-slate-700 sm:col-span-2">{copy.terms}<textarea disabled={!editable} maxLength={3000} value={form.commercialTerms} onChange={(event) => setForm((current) => current ? { ...current, commercialTerms: event.target.value } : current)} className="min-h-28 rounded-md border border-slate-300 p-3 font-normal disabled:bg-slate-50" /></label>
          </div>
        </section>

        <aside className="rounded-xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
          <dl className="space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-slate-300">{copy.subtotal}</dt><dd className="font-semibold">{pricingReady ? money(preview.subtotal, locale) : copy.pricingRequired}</dd></div><div className="flex justify-between gap-3"><dt className="text-slate-300">{copy.tax} ({form.taxRate}%)</dt><dd className="font-semibold">{pricingReady ? money(preview.tax, locale) : copy.pricingRequired}</dd></div><div className="flex justify-between gap-3 border-t border-slate-700 pt-3 text-lg"><dt className="font-semibold">{copy.total}</dt><dd className="font-bold">{pricingReady ? money(preview.total, locale) : copy.pricingRequired}</dd></div></dl>
          <div className="mt-5 grid gap-2">
            {editable ? <button type="button" disabled={busy !== null} onClick={() => void handleSave()} className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-slate-600 bg-slate-900 px-4 text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"><Save className="h-4 w-4" />{busy === "save" ? copy.savingDraft : copy.saveDraft}</button> : null}
            {editable ? <button type="button" disabled={busy !== null || !pricingReady} onClick={() => void handleSend()} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-brand-500 px-4 text-sm font-semibold hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-4 w-4" />{busy === "send" ? copy.sendingQuote : copy.sendQuote}</button> : null}
            {quote.status !== "draft" ? <button type="button" disabled={busy !== null} onClick={() => void handleShare()} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-slate-950 hover:bg-slate-100 disabled:opacity-50"><Link2 className="h-4 w-4" />{busy === "share" ? copy.generatingLink : copy.generateShareLink}</button> : null}
          </div>
        </aside>
      </div>

      {shareUrl ? (
        <section className="rounded-xl border border-brand-200 bg-brand-50 p-4">
          <h2 className="text-sm font-semibold text-brand-900">{copy.shareLink}</h2>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input readOnly value={shareUrl} className="h-11 min-w-0 flex-1 rounded-md border border-brand-200 bg-white px-3 text-sm text-slate-700" /><button type="button" onClick={() => void copyShareUrl()} className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-brand-200 bg-white px-4 text-sm font-semibold text-brand-800">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? copy.copied : copy.copyLink}</button><a href={shareUrl} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center justify-center rounded-md bg-brand-700 px-4 text-white"><ExternalLink className="h-4 w-4" /><span className="sr-only">{copy.open}</span></a></div>
        </section>
      ) : null}
    </div>
  );
}
