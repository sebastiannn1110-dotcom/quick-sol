"use client";

import type { BusinessCategory } from "@/lib/types";
import CategoryBadge from "@/components/CategoryBadge";
import { useLanguage } from "@/components/LanguageProvider";

interface ColumnMapperProps {
  detectedCategory?: BusinessCategory;
  recordsUploaded?: number;
}

export default function ColumnMapper({ detectedCategory, recordsUploaded }: ColumnMapperProps) {
  const { t } = useLanguage();

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">{t("mapper.title")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {t("mapper.description")}
          </p>
        </div>
        {detectedCategory ? <CategoryBadge category={detectedCategory} /> : null}
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">{t("mapper.partNumber")}</p>
          <p className="mt-1 text-slate-500">Part Number, PN, MPN</p>
        </div>
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">{t("mapper.quantity")}</p>
          <p className="mt-1 text-slate-500">Qty, Quantity, Stock</p>
        </div>
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">{t("mapper.status")}</p>
          <p className="mt-1 text-slate-500">{t("mapper.statusHelp")}</p>
        </div>
      </div>
      {recordsUploaded !== undefined ? (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
          {recordsUploaded} {t("mapper.uploaded")}
        </p>
      ) : null}
    </section>
  );
}
