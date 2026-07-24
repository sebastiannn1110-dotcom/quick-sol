"use client";

import { useLanguage } from "@/components/LanguageProvider";
import type { SalesOpportunityWithConfidence } from "@/lib/opportunities/quality";
import {
  accountClientLabel,
  confidenceClass,
  formatOpportunityQuantity,
  opportunityConfidenceKey,
  opportunityActionKey,
  opportunityPartnerLabel,
  opportunitySourceLabel,
  opportunityTypeKey,
  opportunityTypeClass
} from "@/components/opportunities/opportunity-ui";

export default function OpportunityMobileCard({ item }: { item: SalesOpportunityWithConfidence }) {
  const { locale, t } = useLanguage();
  return (
    <details className="rounded-md border border-slate-200 bg-white shadow-sm">
      <summary className="cursor-pointer list-none p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-all font-mono font-semibold text-slate-950">{item.mpn}</p>
            <p className="mt-1 truncate text-sm text-slate-500">{accountClientLabel(item)}</p>
          </div>
          <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${opportunityTypeClass(item.opportunityType)}`}>
            {t(opportunityTypeKey(item.opportunityType))}
          </span>
        </div>
      </summary>
      <div className="grid grid-cols-2 gap-3 border-t border-slate-100 p-4 text-sm">
        <div><p className="text-xs text-slate-500">{t("opportunities.columns.required")}</p><p className="font-medium">{formatOpportunityQuantity(item.requiredQty, locale)}</p></div>
        <div><p className="text-xs text-slate-500">{t("opportunities.columns.available")}</p><p className="font-medium">{formatOpportunityQuantity(item.availableQty, locale)}</p></div>
        <div><p className="text-xs text-slate-500">{t("opportunities.columns.shortage")}</p><p className="font-medium">{formatOpportunityQuantity(item.shortageQty, locale)}</p></div>
        <div><p className="text-xs text-slate-500">{t("opportunities.columns.confidence")}</p><span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${confidenceClass(item.confidenceLabel)}`}>{t(opportunityConfidenceKey(item.confidenceLabel))} {item.confidenceScore}</span></div>
        <div className="col-span-2"><p className="text-xs text-slate-500">{t("opportunities.columns.partner")}</p><p>{opportunityPartnerLabel(item)}</p></div>
        <div className="col-span-2"><p className="text-xs text-slate-500">{t("opportunities.columns.action")}</p><p>{t(opportunityActionKey(item.opportunityType))}</p></div>
        <div className="col-span-2"><p className="text-xs text-slate-500">{t("opportunities.columns.uploads")}</p><p className="break-words">{opportunitySourceLabel(item)}</p></div>
      </div>
    </details>
  );
}
