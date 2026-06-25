"use client";

import { useLanguage } from "@/components/LanguageProvider";

export type ChartType = "bar" | "line" | "pie" | "area" | "donut" | "table";

const OPTIONS: Array<{ value: ChartType; label: string }> = [
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
  { value: "pie", label: "Pie chart" },
  { value: "area", label: "Area chart" },
  { value: "donut", label: "Donut chart" },
  { value: "table", label: "Table view" }
];

export default function ChartTypeSelector({
  value,
  onChange
}: {
  value: ChartType;
  onChange: (value: ChartType) => void;
}) {
  const { t } = useLanguage();

  return (
    <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
      {t("analytics.chartType")}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as ChartType)}
        className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value === "table" ? t("analytics.tableView") : option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
