"use client";

import { useState } from "react";
import type { MetricItem, PlatformAnalyticsSummary } from "@/lib/types";
import { useLanguage } from "@/components/LanguageProvider";
import AnalyticsModal from "@/components/charts/AnalyticsModal";
import MetricCard from "@/components/charts/MetricCard";

function formatValue(value: number | string, locale: string) {
  if (typeof value === "string") return value;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2
  }).format(value);
}

function BarList({ items }: { items: MetricItem[] }) {
  const { t, tl, locale } = useLanguage();

  if (!items.length) {
    return <p className="text-sm text-slate-500">{t("charts.noData")}</p>;
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="space-y-3">
      {items.slice(0, 8).map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700">{tl(item.label)}</span>
            <span className="text-slate-500">{formatValue(item.value, locale)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${Math.max(6, (item.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export { default as MetricCard } from "@/components/charts/MetricCard";

export function ChartCard({ title, items, onOpen }: { title: string; items: MetricItem[]; onOpen?: () => void }) {
  const { t, tl } = useLanguage();

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-950">{tl(title)}</h2>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="text-xs font-semibold text-brand-700 hover:text-brand-900">
            {t("analytics.openChart")}
          </button>
        ) : null}
      </div>
      <BarList items={items} />
    </section>
  );
}

export default function AnalyticsCards({ analytics }: { analytics: PlatformAnalyticsSummary }) {
  const { t, locale } = useLanguage();
  const [modal, setModal] = useState<{
    title: string;
    value: string | number;
    description: string;
    items: MetricItem[];
  } | null>(null);
  const lastUpload = analytics.totals.lastUpload
    ? new Date(analytics.totals.lastUpload).toLocaleString(locale)
    : t("history.empty");
  const metricCards = [
    {
      label: "Total records",
      value: analytics.totals.totalRecords,
      description: "Total normalized business records imported from uploaded Excel files.",
      items: analytics.recordsOverTime.length ? analytics.recordsOverTime : analytics.recordsByCategory
    },
    {
      label: "Total uploads",
      value: analytics.totals.totalUploads,
      description: "Total upload batches that are active and not archived.",
      items: analytics.uploadsByEmployee
    },
    {
      label: "Active employees",
      value: analytics.totals.totalEmployeesActive,
      description: "Employees with active profiles who can use the platform.",
      items: analytics.employeesByRole.length ? analytics.employeesByRole : analytics.employeesByDepartment
    },
    {
      label: "Categories detected",
      value: analytics.totals.categoriesDetected,
      description: "Distinct business categories detected across imported records.",
      items: analytics.recordsByCategory
    },
    {
      label: "Total QTY",
      value: analytics.totals.totalQty,
      description: "Sum of quantity fields detected in normalized business records.",
      items: analytics.recordsByCategory
    },
    {
      label: "Potential Amount USD",
      value: analytics.totals.totalPotentialAmountUsd,
      description: "Potential amount in USD imported or calculated from RFQ/customer demand files.",
      items: analytics.recordsByCustomer
    },
    {
      label: "Total Price",
      value: analytics.totals.totalPrice,
      description: "Total price imported or calculated from price multiplied by quantity.",
      items: analytics.recordsByCustomer
    },
    {
      label: "GP Total",
      value: analytics.totals.grossProfitTotal,
      description: "Gross Profit total. Estimated profit calculated from price minus cost multiplied by quantity, or imported directly from the Excel when available.",
      items: analytics.recordsBySupplier
    },
    {
      label: "Average GP Rate",
      value: analytics.totals.averageGpRate,
      description: "Average gross profit rate. A value of 0.30 means approximately 30%.",
      items: analytics.recordsByCustomer
    },
    {
      label: "Commission Total",
      value: analytics.totals.commissionTotal,
      description: "Total commission detected in uploaded records.",
      items: analytics.recordsBySupplier
    },
    {
      label: "Records with errors",
      value: analytics.totals.recordsWithErrors,
      description: "Rows or cells with detected problems during import, such as invalid numbers, formula errors, missing fields or unknown columns.",
      items: analytics.recordsByCategory
    },
    {
      label: "Incomplete records",
      value: analytics.totals.incompleteRecords,
      detail: lastUpload,
      description: "Rows missing important business fields such as MPN, Customer, Supplier, QTY or Price.",
      items: analytics.recordsByCategory
    },
    {
      label: "Records missing MPN",
      value: analytics.totals.recordsMissingMpn,
      description: "Records where no MPN, Part Number, PN or MPN Quoted value could be detected.",
      items: analytics.topMpns
    }
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map((card) => (
          <MetricCard
            key={card.label}
            label={card.label}
            value={card.value}
            detail={card.detail}
            description={card.description}
            onOpen={() => setModal({ title: card.label, value: card.value, description: card.description, items: card.items })}
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Records by category" items={analytics.recordsByCategory} onOpen={() => setModal({ title: "Records by category", value: analytics.totals.totalRecords, description: "Records grouped by detected business category.", items: analytics.recordsByCategory })} />
        <ChartCard title="Uploads by employee" items={analytics.uploadsByEmployee} onOpen={() => setModal({ title: "Uploads by employee", value: analytics.totals.totalUploads, description: "Upload batches grouped by employee.", items: analytics.uploadsByEmployee })} />
        <ChartCard title="Top MPNs" items={analytics.topMpns} onOpen={() => setModal({ title: "Top MPNs", value: analytics.totals.recordsMissingMpn ? `${analytics.topMpns.length} groups` : analytics.topMpns.length, description: "Most frequent manufacturer part numbers detected in the uploaded data. Missing MPN is separated as a data quality warning.", items: analytics.topMpns })} />
      </div>
      <AnalyticsModal
        open={Boolean(modal)}
        title={modal?.title ?? ""}
        value={modal?.value ?? ""}
        description={modal?.description ?? ""}
        items={modal?.items ?? []}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
