"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Mail,
  MapPin,
  Phone,
  UserRound
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import RfqStatusChip from "@/components/commerce/RfqStatusChip";
import { DemoAccountBadge, DemoAccountNotice } from "@/components/clients/DemoAccount";
import { CommerceApiError, commerceRequest } from "@/lib/commerce/client";
import { commerceCopy } from "@/lib/commerce/ui-i18n";
import {
  isUiNewRfq,
  normalizeCommerceQuote,
  normalizeRfqDetail,
  type CommerceQuoteUi,
  type CommerceRfqDetail as RfqDetailModel
} from "@/lib/commerce/ui-model";

type RfqActionBody =
  | { action: "mark_in_review" }
  | { action: "assign_seller"; sellerId: string }
  | { action: "create_client" };

type QuoteDraftInput = {
  validUntil: string;
  notes: string;
  commercialTerms: string;
  taxRate: number;
};

async function defaultLoad(rfqId: string, signal?: AbortSignal) {
  return normalizeRfqDetail(await commerceRequest<unknown>(`/api/commerce/rfqs/${encodeURIComponent(rfqId)}`, { signal }));
}

async function defaultAction(rfqId: string, body: RfqActionBody) {
  return normalizeRfqDetail(await commerceRequest<unknown>(`/api/commerce/rfqs/${encodeURIComponent(rfqId)}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  }));
}

async function defaultCreateQuote(rfqId: string, body: QuoteDraftInput) {
  return normalizeCommerceQuote(await commerceRequest<unknown>(`/api/commerce/rfqs/${encodeURIComponent(rfqId)}/quote`, {
    method: "POST",
    body: JSON.stringify(body)
  }));
}

function futureDate(days = 30) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string, locale: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(date);
}

function money(value: number | null, locale: string) {
  return value === null
    ? "—"
    : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
}

export default function RfqDetail({
  rfqId,
  load = defaultLoad,
  runAction = defaultAction,
  createQuote = defaultCreateQuote
}: {
  rfqId: string;
  load?: (rfqId: string, signal?: AbortSignal) => Promise<RfqDetailModel>;
  runAction?: (rfqId: string, body: RfqActionBody) => Promise<RfqDetailModel>;
  createQuote?: (rfqId: string, body: QuoteDraftInput) => Promise<CommerceQuoteUi>;
}) {
  const router = useRouter();
  const { language, locale } = useLanguage();
  const copy = commerceCopy(language);
  const [rfq, setRfq] = useState<RfqDetailModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState<"review" | "assign" | "client" | "quote" | null>(null);
  const [sellerId, setSellerId] = useState("");
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [pricingError, setPricingError] = useState(false);
  const [quoteInput, setQuoteInput] = useState<QuoteDraftInput>({
    validUntil: futureDate(),
    notes: "",
    commercialTerms: "",
    taxRate: 7
  });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const next = await load(rfqId, signal);
      if (!signal?.aborted) {
        setRfq(next);
        setSellerId(next.assignedSeller?.id ?? "");
      }
    } catch {
      if (!signal?.aborted) setError(copy.loadError);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [copy.loadError, load, rfqId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function handleAction(kind: "review" | "assign" | "client", body: RfqActionBody) {
    setAction(kind);
    setError("");
    try {
      const next = await runAction(rfqId, body);
      setRfq(next);
      setSellerId(next.assignedSeller?.id ?? "");
    } catch (actionError) {
      setError(actionError instanceof CommerceApiError ? actionError.message : copy.loadError);
    } finally {
      setAction(null);
    }
  }

  async function handleCreateQuote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAction("quote");
    setError("");
    setPricingError(false);
    try {
      const quote = await createQuote(rfqId, quoteInput);
      router.push(`/admin/quotes/${encodeURIComponent(quote.id)}`);
    } catch (quoteError) {
      if (quoteError instanceof CommerceApiError && quoteError.code === "PRICING_REQUIRED") {
        setPricingError(true);
      } else {
        setError(quoteError instanceof Error ? quoteError.message : copy.loadError);
      }
    } finally {
      setAction(null);
    }
  }

  const missingPricing = useMemo(
    () => rfq?.items.filter((item) => !item.pricing?.available) ?? [],
    [rfq]
  );

  if (loading) return <div className="py-16 text-center text-sm text-slate-500">{copy.loading}</div>;
  if (!rfq) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p>{error || copy.loadError}</p>
        <button type="button" className="mt-3 font-semibold underline" onClick={() => void refresh()}>{copy.retry}</button>
      </div>
    );
  }

  const showPricingRequired = !rfq.pricingReady || pricingError;
  const isNew = isUiNewRfq(rfq);

  return (
    <div className="space-y-6" data-testid="rfq-detail">
      <Link href="/admin/rfqs" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-950">
        <ArrowLeft className="h-4 w-4" />{copy.backToInbox}
      </Link>

      <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <RfqStatusChip status={rfq.status} language={language} />
              {isNew ? <RfqStatusChip status={rfq.status} language={language} isNew /> : null}
              <DemoAccountBadge accountName={rfq.companyOrName} />
            </div>
            <h1 className="mt-3 break-words text-2xl font-semibold text-slate-950 sm:text-3xl">{rfq.companyOrName || "RFQ"}</h1>
            <DemoAccountNotice accountName={rfq.companyOrName} className="mt-2" />
          </div>
          <dl className="grid min-w-0 gap-3 text-xs sm:grid-cols-2 lg:max-w-xl">
            <div className="rounded-lg bg-slate-50 px-3 py-2"><dt className="text-slate-500">{copy.date}</dt><dd className="mt-1 font-semibold text-slate-800">{formatDate(rfq.createdAt, locale)}</dd></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2"><dt className="text-slate-500">{copy.source}</dt><dd className="mt-1 font-semibold text-slate-800">{rfq.source}</dd></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 sm:col-span-2"><dt className="text-slate-500">{copy.externalId}</dt><dd className="mt-1 break-all font-mono text-[11px] font-semibold text-slate-800">{rfq.externalRfqId || "—"}</dd></div>
          </dl>
        </div>
      </header>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">{error}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950"><UserRound className="h-5 w-5 text-brand-700" />{copy.contact}</h2>
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.contact}</dt><dd className="mt-1 font-semibold text-slate-900">{rfq.contact.contact || "—"}</dd></div>
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.email}</dt><dd className="mt-1 break-all text-slate-800"><Mail className="mr-1.5 inline h-4 w-4 text-slate-400" />{rfq.contact.email || "—"}</dd></div>
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.phone}</dt><dd className="mt-1 text-slate-800"><Phone className="mr-1.5 inline h-4 w-4 text-slate-400" />{rfq.contact.phone || "—"}</dd></div>
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.country}</dt><dd className="mt-1 text-slate-800"><MapPin className="mr-1.5 inline h-4 w-4 text-slate-400" />{rfq.contact.country || "—"}</dd></div>
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.city}</dt><dd className="mt-1 text-slate-800">{rfq.contact.city || "—"}</dd></div>
              <div><dt className="text-xs font-medium uppercase text-slate-500">{copy.language}</dt><dd className="mt-1 uppercase text-slate-800">{rfq.contact.preferredLanguage || "—"}</dd></div>
              <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs font-medium uppercase text-slate-500">{copy.notes}</dt><dd className="mt-1 whitespace-pre-wrap text-slate-700">{rfq.contact.notes || copy.noNotes}</dd></div>
            </dl>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-950"><ClipboardList className="h-5 w-5 text-brand-700" />{copy.products}</h2>
              <span className="text-xs font-semibold text-slate-500">{rfq.items.length} {copy.lines.toLowerCase()}</span>
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">{copy.mpn}</th><th className="px-4 py-3">{copy.description}</th><th className="px-4 py-3">{copy.quantity}</th><th className="px-4 py-3">{copy.targetPrice}</th><th className="px-4 py-3">{copy.authorizedPrice}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rfq.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-4 align-top"><p className="font-mono font-bold text-slate-950">{item.mpn}</p><p className="mt-1 text-xs text-slate-500">{item.manufacturer || "—"}</p></td>
                      <td className="max-w-sm px-4 py-4 align-top text-slate-700">{item.description || "—"}</td>
                      <td className="px-4 py-4 align-top font-semibold text-slate-900">{item.quantity}</td>
                      <td className="px-4 py-4 align-top text-slate-700">{money(item.targetPrice, locale)}</td>
                      <td className="px-4 py-4 align-top">{item.pricing?.available && item.pricing.authorizedUnitPrice !== null ? <span className="font-semibold text-emerald-700">{money(item.pricing.authorizedUnitPrice, locale)}</span> : <span className="font-semibold text-amber-700">{copy.pricingRequired}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y divide-slate-100 md:hidden">
              {rfq.items.map((item) => (
                <article key={item.id} className="p-4">
                  <div className="flex items-start justify-between gap-3"><div><p className="font-mono font-bold text-slate-950">{item.mpn}</p><p className="mt-1 text-xs text-slate-500">{item.manufacturer || "—"}</p></div><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">{copy.qty} {item.quantity}</span></div>
                  <p className="mt-3 text-sm text-slate-700">{item.description || "—"}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><dt className="text-slate-500">{copy.targetPrice}</dt><dd className="mt-1 font-medium">{money(item.targetPrice, locale)}</dd></div><div><dt className="text-slate-500">{copy.authorizedPrice}</dt><dd className={`mt-1 font-semibold ${item.pricing?.available ? "text-emerald-700" : "text-amber-700"}`}>{item.pricing?.available ? money(item.pricing.authorizedUnitPrice, locale) : copy.pricingRequired}</dd></div></dl>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{copy.assignment}</h2>
            <p className="mt-3 text-lg font-semibold text-slate-950">{rfq.assignedSeller?.fullName || copy.unassignedSeller}</p>
            {rfq.assignedSeller?.email ? <p className="mt-1 break-all text-xs text-slate-500">{rfq.assignedSeller.email}</p> : null}
            {rfq.actions.assignSeller ? (
              <div className="mt-4 space-y-2">
                <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.assignSeller}
                  <select value={sellerId} onChange={(event) => setSellerId(event.target.value)} className="h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900">
                    <option value="">{copy.selectSeller}</option>
                    {rfq.assignableSellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.fullName}</option>)}
                  </select>
                </label>
                <button type="button" disabled={!sellerId || action !== null} onClick={() => void handleAction("assign", { action: "assign_seller", sellerId })} className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{action === "assign" ? copy.assigning : copy.assignSeller}</button>
              </div>
            ) : null}
            {rfq.actions.markInReview ? <button type="button" disabled={action !== null} onClick={() => void handleAction("review", { action: "mark_in_review" })} className="mt-3 h-10 w-full rounded-md bg-violet-600 px-3 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">{action === "review" ? copy.markingInReview : copy.markInReview}</button> : null}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><Building2 className="h-4 w-4" />{rfq.client ? copy.linkedClient : copy.newProspect}</h2>
            {rfq.client ? (
              <Link href={`/clients/${encodeURIComponent(rfq.client.id)}`} className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 font-semibold text-slate-900 hover:bg-slate-100"><span>{rfq.client.name}</span><ArrowRight className="h-4 w-4" /></Link>
            ) : (
              <>
                <p className="mt-3 text-sm text-slate-600">{rfq.contact.companyOrName}</p>
                {rfq.actions.createClient ? <button type="button" disabled={action !== null} onClick={() => void handleAction("client", { action: "create_client" })} className="mt-4 h-11 w-full rounded-md bg-slate-950 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">{action === "client" ? copy.creatingClient : copy.createClient}</button> : null}
              </>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500"><CalendarDays className="h-4 w-4" />{copy.quote}</h2>
            {rfq.quote ? (
              <>
                <p className="mt-3 text-sm text-slate-600">{copy.quoteAlreadyCreated}</p>
                <Link href={`/admin/quotes/${encodeURIComponent(rfq.quote.id)}`} className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700">{copy.openQuote}<ArrowRight className="h-4 w-4" /></Link>
              </>
            ) : (
              <>
                {showPricingRequired ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
                    <p className="font-semibold">{copy.pricingRequired}</p>
                    <p className="mt-1 text-xs">{copy.pricingRequiredHelp}</p>
                    {missingPricing.length ? <p className="mt-2 font-mono text-xs font-semibold">{missingPricing.map((item) => item.mpn).join(", ")}</p> : null}
                  </div>
                ) : <p className="mt-3 flex items-center gap-2 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" />{copy.pricingReady}</p>}
                {!showQuoteForm ? (
                  <button type="button" disabled={!rfq.client || !rfq.actions.createQuote} onClick={() => setShowQuoteForm(true)} className="mt-4 h-11 w-full rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50">{copy.createQuote}</button>
                ) : (
                  <form className="mt-4 space-y-3" onSubmit={(event) => void handleCreateQuote(event)}>
                    <p className="font-semibold text-slate-900">{copy.createQuoteSettings}</p>
                    <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.validUntil}<input required type="date" value={quoteInput.validUntil} onChange={(event) => setQuoteInput((current) => ({ ...current, validUntil: event.target.value }))} className="h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label>
                    <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.taxRate}<input required min="0" max="100" step="0.01" type="number" value={quoteInput.taxRate} onChange={(event) => setQuoteInput((current) => ({ ...current, taxRate: Number(event.target.value) }))} className="h-11 rounded-md border border-slate-300 px-3 text-sm font-normal text-slate-900" /></label>
                    <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.notes}<textarea maxLength={2000} value={quoteInput.notes} onChange={(event) => setQuoteInput((current) => ({ ...current, notes: event.target.value }))} className="min-h-20 rounded-md border border-slate-300 p-3 text-sm font-normal text-slate-900" /></label>
                    <label className="grid gap-1 text-xs font-semibold text-slate-600">{copy.terms}<textarea maxLength={3000} value={quoteInput.commercialTerms} onChange={(event) => setQuoteInput((current) => ({ ...current, commercialTerms: event.target.value }))} className="min-h-20 rounded-md border border-slate-300 p-3 text-sm font-normal text-slate-900" /></label>
                    <div className="grid grid-cols-2 gap-2"><button type="button" className="h-10 rounded-md border border-slate-300 text-sm font-semibold text-slate-700" onClick={() => setShowQuoteForm(false)}>{copy.cancel}</button><button type="submit" disabled={action !== null} className="h-10 rounded-md bg-brand-600 text-sm font-semibold text-white disabled:opacity-50">{action === "quote" ? copy.creatingQuote : copy.continueCreateQuote}</button></div>
                  </form>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
