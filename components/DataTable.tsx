"use client";

import { useMemo, useState } from "react";
import CategoryBadge from "@/components/CategoryBadge";
import { useLanguage } from "@/components/LanguageProvider";
import type { BusinessCategory, BusinessRecord, PlatformRecord } from "@/lib/types";

type PlatformListRecord = Omit<PlatformRecord, "raw_data" | "normalized_data" | "errors" | "searchable_text"> &
  Partial<Pick<PlatformRecord, "raw_data" | "normalized_data" | "errors" | "searchable_text">>;
type RecordLike = BusinessRecord | PlatformListRecord;

function isPlatformRecord(record: RecordLike): record is PlatformListRecord {
  return "upload_batch_id" in record;
}

function categoryOf(record: RecordLike) {
  return (isPlatformRecord(record) ? record.category ?? "Generic" : record.category) as BusinessCategory;
}

function primaryValue(record: RecordLike) {
  if (isPlatformRecord(record)) {
    return (
      record.mpn ||
      record.mpn_quoted ||
      record.customer ||
      record.client ||
      record.supplier_name ||
      record.supplier ||
      record.line_id ||
      record.po ||
      record.description ||
      "Record"
    );
  }

  const candidates = [
    "partNumber",
    "companyName",
    "supplierName",
    "rfqId",
    "orderId",
    "shipmentId",
    "inspectionId",
    "employeeName",
    "componentCategory"
  ];

  for (const key of candidates) {
    const value = record.normalizedData[key];
    if (value !== null && value !== undefined && !Array.isArray(value)) return String(value);
  }

  const firstValue = Object.values(record.normalizedData)[0] ?? Object.values(record.rawData)[0];
  return firstValue === undefined || firstValue === null ? "Record" : String(firstValue);
}

function statusValue(record: RecordLike) {
  if (isPlatformRecord(record)) {
    return record.has_errors ? "Has errors" : record.upload_batches?.status ?? "Clean";
  }

  const candidates = [
    "status",
    "paymentStatus",
    "shippingStatus",
    "currentStatus",
    "customsStatus",
    "finalStatus",
    "riskLevel",
    "marketTrend"
  ];
  for (const key of candidates) {
    const value = record.normalizedData[key];
    if (value !== null && value !== undefined && !Array.isArray(value)) return String(value);
  }
  return "Unspecified";
}

function employeeOf(record: RecordLike) {
  if (isPlatformRecord(record)) {
    return {
      name: record.profiles?.full_name ?? record.uploaded_by,
      id: record.uploaded_by
    };
  }
  return { name: record.employeeName, id: record.employeeId };
}

function sourceOf(record: RecordLike) {
  if (isPlatformRecord(record)) {
    return {
      source: record.upload_batches?.original_file_name ?? "Supabase",
      row: record.row_index ?? "-"
    };
  }
  return { source: record.sourceSheet, row: record.originalRowIndex };
}

function rawDataOf(record: RecordLike) {
  return isPlatformRecord(record) ? record.raw_data : record.rawData;
}

function normalizedDataOf(record: RecordLike) {
  return isPlatformRecord(record) ? record.normalized_data : record.normalizedData;
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-900">{title}</h3>
      <pre className="max-h-80 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export default function DataTable({ records }: { records: RecordLike[] }) {
  const { t } = useLanguage();
  const [selectedRecord, setSelectedRecord] = useState<RecordLike | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const visibleRecords = useMemo(() => records.slice(0, 500), [records]);
  const translatedStatus = (status: string) => {
    if (status === "Has errors") return t("table.hasErrors");
    if (status === "Clean") return t("table.clean");
    if (status === "Unspecified") return t("table.unspecified");
    return status;
  };

  async function openRecord(record: RecordLike) {
    setSelectedRecord(record);
    setDetailError("");
    if (!isPlatformRecord(record) || (record.raw_data !== undefined && record.normalized_data !== undefined)) return;
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/records/${encodeURIComponent(record.id)}`, { cache: "no-store" });
      const payload = await response.json() as { record?: Partial<PlatformRecord>; error?: string };
      if (!response.ok || !payload.record) throw new Error(payload.error ?? "Unable to load detail.");
      setSelectedRecord({ ...record, ...payload.record } as PlatformRecord);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Unable to load detail.");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">{t("table.title")}</h2>
          <p className="text-xs text-slate-500">
            {t("table.showing")} {visibleRecords.length} {t("table.of")} {records.length}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50/90 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("table.primary")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("table.category")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("table.employee")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("table.status")}</th>
              <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("table.source")}</th>
              <th className="px-4 py-3 text-right font-semibold text-slate-600">{t("table.details")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {visibleRecords.map((record) => {
              const employee = employeeOf(record);
              const source = sourceOf(record);
              const status = statusValue(record);
              return (
                <tr key={record.id} className="transition-colors hover:bg-blue-50/40">
                  <td className="max-w-xs px-4 py-3">
                    <p className="truncate font-medium text-slate-950">{primaryValue(record)}</p>
                    <p className="truncate text-xs text-slate-500">{record.id}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <CategoryBadge category={categoryOf(record)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {employee.name}
                    <span className="block text-xs text-slate-400">{employee.id}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{translatedStatus(status)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {source.source}
                    <span className="block text-xs text-slate-400">{t("table.row")} {source.row}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void openRecord(record)}
                      className="focus-ring rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                    >
                      {t("table.view")}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!visibleRecords.length ? (
              <tr>
                <td className="px-4 py-8 text-center text-slate-500" colSpan={6}>
                  {t("table.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedRecord ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-4 sm:items-center">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-white shadow-soft">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">{t("table.recordDetails")}</h2>
                <p className="text-sm text-slate-500">{t("table.traceable")}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRecord(null)}
                className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
              >
                {t("table.close")}
              </button>
            </div>
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              {detailLoading ? (
                <p className="text-sm text-slate-500">{t("records.loading")}</p>
              ) : detailError ? (
                <p className="text-sm text-red-700">{detailError}</p>
              ) : (
                <>
                  <JsonBlock title={t("table.normalized")} value={normalizedDataOf(selectedRecord)} />
                  <JsonBlock title={t("table.raw")} value={rawDataOf(selectedRecord)} />
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
