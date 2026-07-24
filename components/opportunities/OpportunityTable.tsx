"use client";

import { useLanguage } from "@/components/LanguageProvider";
import OpportunityMobileCard from "@/components/opportunities/OpportunityMobileCard";
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

export default function OpportunityTable({ items, loading }: { items: SalesOpportunityWithConfidence[]; loading: boolean }) {
  const { locale, t } = useLanguage();

  if (loading) return <div className="py-10 text-center text-sm text-slate-500">{t("opportunities.loading")}</div>;
  if (!items.length) return <div className="py-10 text-center text-sm text-slate-500">{t("opportunities.empty")}</div>;

  return (
    <>
      <div className="grid gap-3 lg:hidden">
        {items.map((item) => <OpportunityMobileCard key={item.id} item={item} />)}
      </div>
      <div className="hidden overflow-x-auto lg:block">
          <table className="min-w-[1080px] divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">{t("opportunities.columns.type")}</th>
              <th className="px-4 py-3">MPN</th>
              <th className="px-4 py-3">{t("opportunities.columns.accountClient")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.customerNeed")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.partner")}</th>
              <th className="px-4 py-3 text-right">{t("opportunities.columns.required")}</th>
              <th className="px-4 py-3 text-right">{t("opportunities.columns.available")}</th>
              <th className="px-4 py-3 text-right">{t("opportunities.columns.shortage")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.approved")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.received")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.confidence")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.action")}</th>
              <th className="px-4 py-3">{t("opportunities.columns.uploads")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {items.map((item) => (
              <tr key={item.id} className="align-top hover:bg-slate-50">
                <td className="px-4 py-3"><span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${opportunityTypeClass(item.opportunityType)}`}>{t(opportunityTypeKey(item.opportunityType))}</span></td>
                <td className="px-4 py-3 break-all font-mono font-semibold text-slate-950">{item.mpn}</td>
                <td className="px-4 py-3 text-slate-700">{accountClientLabel(item)}</td>
                <td className="px-4 py-3 text-slate-700">{item.customerNeedName ?? "-"}</td>
                <td className="px-4 py-3 text-slate-700">{opportunityPartnerLabel(item)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatOpportunityQuantity(item.requiredQty, locale)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatOpportunityQuantity(item.availableQty, locale)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatOpportunityQuantity(item.shortageQty, locale)}</td>
                <td className="px-4 py-3">{item.approvedPartSignal ? t("common.yes") : t("common.no")}</td>
                <td className="px-4 py-3">{item.receivedSignal ? t("common.yes") : t("common.no")}</td>
                <td className="px-4 py-3"><span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${confidenceClass(item.confidenceLabel)}`}>{t(opportunityConfidenceKey(item.confidenceLabel))} {item.confidenceScore}</span></td>
                <td className="min-w-64 px-4 py-3 text-slate-700">{t(opportunityActionKey(item.opportunityType))}</td>
                <td className="max-w-xs px-4 py-3 text-slate-700"><span className="block truncate">{opportunitySourceLabel(item)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
