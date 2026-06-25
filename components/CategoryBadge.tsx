"use client";

import { useLanguage } from "@/components/LanguageProvider";
import type { BusinessCategory } from "@/lib/types";

const COLORS: Record<BusinessCategory, string> = {
  "Sales Margin": "bg-emerald-50 text-emerald-700 ring-emerald-200",
  "Customer Demand": "bg-cyan-50 text-cyan-700 ring-cyan-200",
  "Supplier Offers": "bg-teal-50 text-teal-700 ring-teal-200",
  Generic: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  Inventory: "bg-blue-50 text-blue-700 ring-blue-200",
  Customers: "bg-cyan-50 text-cyan-700 ring-cyan-200",
  Suppliers: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  RFQ: "bg-violet-50 text-violet-700 ring-violet-200",
  Orders: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Logistics: "bg-sky-50 text-sky-700 ring-sky-200",
  Quality: "bg-amber-50 text-amber-700 ring-amber-200",
  "Quality Inspection": "bg-amber-50 text-amber-700 ring-amber-200",
  "Market Insights": "bg-teal-50 text-teal-700 ring-teal-200",
  Finance: "bg-slate-100 text-slate-700 ring-slate-200",
  Employees: "bg-rose-50 text-rose-700 ring-rose-200",
  Unknown: "bg-zinc-100 text-zinc-700 ring-zinc-200"
};

export default function CategoryBadge({ category }: { category: BusinessCategory }) {
  const { tc } = useLanguage();

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset ${
        COLORS[category] ?? COLORS.Unknown
      }`}
    >
      {tc(category)}
    </span>
  );
}
