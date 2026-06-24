import type { MetricItem, PlatformAnalyticsSummary } from "@/lib/types";

function formatValue(value: number | string) {
  if (typeof value === "string") return value;
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2
  }).format(value);
}

function BarList({ items }: { items: MetricItem[] }) {
  if (!items.length) {
    return <p className="text-sm text-slate-500">No data available.</p>;
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="space-y-3">
      {items.slice(0, 8).map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-700">{item.label}</span>
            <span className="text-slate-500">{formatValue(item.value)}</span>
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

export function MetricCard({
  label,
  value,
  detail
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{formatValue(value)}</p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

export function ChartCard({ title, items }: { title: string; items: MetricItem[] }) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">{title}</h2>
      <BarList items={items} />
    </section>
  );
}

export default function AnalyticsCards({ analytics }: { analytics: PlatformAnalyticsSummary }) {
  const lastUpload = analytics.totals.lastUpload
    ? new Date(analytics.totals.lastUpload).toLocaleString()
    : "No uploads yet";

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total records" value={analytics.totals.totalRecords} />
        <MetricCard label="Total uploads" value={analytics.totals.totalUploads} />
        <MetricCard label="Active employees" value={analytics.totals.totalEmployeesActive} />
        <MetricCard label="Categories detected" value={analytics.totals.categoriesDetected} />
        <MetricCard label="Total QTY" value={analytics.totals.totalQty} />
        <MetricCard label="Potential Amount USD" value={analytics.totals.totalPotentialAmountUsd} />
        <MetricCard label="Total Price" value={analytics.totals.totalPrice} />
        <MetricCard label="GP Total" value={analytics.totals.grossProfitTotal} />
        <MetricCard label="Average GP Rate" value={analytics.totals.averageGpRate} />
        <MetricCard label="Commission Total" value={analytics.totals.commissionTotal} />
        <MetricCard label="Records with errors" value={analytics.totals.recordsWithErrors} />
        <MetricCard label="Incomplete records" value={analytics.totals.incompleteRecords} detail={lastUpload} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Records by category" items={analytics.recordsByCategory} />
        <ChartCard title="Uploads by employee" items={analytics.uploadsByEmployee} />
        <ChartCard title="Top MPNs" items={analytics.topMpns} />
      </div>
    </div>
  );
}
