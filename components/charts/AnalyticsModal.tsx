"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { X } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { MetricItem } from "@/lib/types";
import ChartTypeSelector, { type ChartType } from "@/components/charts/ChartTypeSelector";

const COLORS = ["#2563eb", "#f97316", "#10b981", "#a855f7", "#ef4444", "#14b8a6", "#f59e0b", "#64748b"];

function downloadCsv(title: string, rows: MetricItem[]) {
  const csv = [
    ["label", "value", "percent"],
    ...rows.map((row) => [row.label, String(row.value), row.percent === undefined ? "" : String(row.percent)])
  ]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "analytics"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsModal({
  open,
  title,
  value,
  description,
  items,
  onClose
}: {
  open: boolean;
  title: string;
  value: string | number;
  description: string;
  items: MetricItem[];
  onClose: () => void;
}) {
  const { t, tl, locale } = useLanguage();
  const [chartType, setChartType] = useState<ChartType>("bar");
  const rows = useMemo(
    () => items.map((item) => ({ ...item, label: tl(item.label) })),
    [items, tl]
  );
  const formattedValue =
    typeof value === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value)
      : value;

  if (!open) return null;

  const chart = (() => {
    if (!rows.length || chartType === "table") {
      return (
        <div className="max-h-80 overflow-auto rounded-md border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-slate-600">Label</th>
                <th className="px-3 py-2 text-right font-semibold text-slate-600">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="px-3 py-2 text-slate-700">{row.label}</td>
                  <td className="px-3 py-2 text-right font-medium text-slate-950">{row.value}</td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500" colSpan={2}>
                    {t("charts.noData")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      );
    }

    if (chartType === "pie" || chartType === "donut") {
      return (
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="label"
              innerRadius={chartType === "donut" ? 72 : 0}
              outerRadius={120}
              label
            >
              {rows.map((row, index) => (
                <Cell key={row.label} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      );
    }

    if (chartType === "line") {
      return (
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      );
    }

    if (chartType === "area") {
      return (
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis />
            <Tooltip />
            <Area type="monotone" dataKey="value" stroke="#2563eb" fill="#bfdbfe" />
          </AreaChart>
        </ResponsiveContainer>
      );
    }

    return (
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis />
          <Tooltip />
          <Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  })();

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
      <section className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-md bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
          <div>
            <p className="text-sm font-medium text-brand-700">{t("analytics.openChart")}</p>
            <h2 className="text-xl font-semibold text-slate-950">{tl(title)}</h2>
            <p className="mt-1 text-3xl font-semibold text-slate-950">{formattedValue}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label={t("analytics.closeChart")}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-3xl text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{t("analytics.description")}:</span> {description}
            </p>
            <div className="flex flex-wrap gap-2">
              <ChartTypeSelector value={chartType} onChange={setChartType} />
              <button
                type="button"
                onClick={() => downloadCsv(title, rows)}
                className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {t("analytics.exportCsv")}
              </button>
            </div>
          </div>
          {chart}
        </div>
      </section>
    </div>
  );
}
