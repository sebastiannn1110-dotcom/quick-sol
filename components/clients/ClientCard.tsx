"use client";

import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  FileSpreadsheet,
  PackageSearch,
  Search,
  ShoppingCart,
  Sparkles,
  Split,
  Warehouse
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { AccountClient } from "@/lib/clients/clients";

export default function ClientCard({ client }: { client: AccountClient }) {
  const { t } = useLanguage();
  return (
    <Link
      href={`/clients/${client.id}`}
      className="group grid min-h-[390px] grid-rows-[104px_auto_1fr_auto] overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm transition hover:border-brand-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-center justify-center border-b border-slate-100 bg-slate-50 p-4">
        {client.logoUrl ? (
          // Signed Supabase URLs are dynamic, so next/image cannot statically allow their host.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={client.logoUrl} alt="" className="h-16 w-full object-contain" />
        ) : (
          <Building2 className="h-12 w-12 text-slate-300" aria-hidden="true" />
        )}
      </div>
      <div className="px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="break-words text-lg font-semibold text-slate-950 group-hover:text-brand-700">{client.name}</h2>
          <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${client.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-100 text-slate-600"}`}>
            {t(client.status === "active" ? "clients.status.active" : "clients.status.archived")}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 content-start gap-x-3 gap-y-3 p-4 text-sm text-slate-600">
        <span className="flex min-w-0 items-center gap-2"><FileSpreadsheet className="h-4 w-4 shrink-0 text-slate-400" /><span>{client.fileCount} {t("clients.files")}</span></span>
        <span className="flex min-w-0 items-center gap-2"><PackageSearch className="h-4 w-4 shrink-0 text-slate-400" /><span>{client.mpnCount} {t("clients.mpns")}</span></span>
        <span className="flex min-w-0 items-center gap-2"><Sparkles className="h-4 w-4 shrink-0 text-slate-400" /><span>{client.opportunityCount} {t("clients.opportunities")}</span></span>
        <span className="flex min-w-0 items-center gap-2"><ShoppingCart className="h-4 w-4 shrink-0 text-emerald-600" /><span>{client.immediateSaleCount} {t("clients.immediateSales")}</span></span>
        <span className="flex min-w-0 items-center gap-2"><Split className="h-4 w-4 shrink-0 text-amber-600" /><span>{client.partialSaleCount} {t("clients.partialSales")}</span></span>
        <span className="flex min-w-0 items-center gap-2"><Search className="h-4 w-4 shrink-0 text-red-600" /><span>{client.sourcingNeededCount} {t("clients.sourcingNeeded")}</span></span>
        <span className="col-span-2 flex min-w-0 items-center gap-2"><Warehouse className="h-4 w-4 shrink-0 text-sky-600" /><span>{client.stockWithoutDemandCount} {t("clients.stockWithoutDemand")}</span></span>
        <span className="col-span-2 flex min-w-0 items-center gap-2"><BadgeCheck className="h-4 w-4 shrink-0 text-emerald-600" /><span>{client.highConfidenceCount}{client.highConfidenceTruncated ? "+" : ""} {t("clients.highConfidence")}</span></span>
      </div>
      <div className="flex min-h-11 items-center justify-between border-t border-slate-100 px-4 py-3 text-sm font-semibold text-brand-700">
        <span>{t("clients.viewClient")}</span>
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
      </div>
    </Link>
  );
}
