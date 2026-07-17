"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import AdminManagerGuard from "@/components/AdminManagerGuard";
import type { CoverageStatus, StockNeedsItem, StockNeedsResult } from "@/lib/stock-needs/stock-needs";

const COVERAGE_OPTIONS: Array<{ value: "" | CoverageStatus; label: string }> = [
  { value: "", label: "All coverage" },
  { value: "in_stock", label: "In stock" },
  { value: "partial_stock", label: "Partial stock" },
  { value: "no_stock", label: "No stock" },
  { value: "overstock", label: "Overstock" },
  { value: "unknown", label: "Unknown" }
];

const EMPTY_RESULT: StockNeedsResult = {
  items: [],
  totals: {
    totalItems: 0,
    inStock: 0,
    partialStock: 0,
    noStock: 0,
    overstock: 0,
    unknown: 0,
    totalRequiredQty: 0,
    totalStockQty: 0
  },
  meta: {
    limit: 50,
    offset: 0,
    returnedItems: 0,
    scannedRecords: 0,
    missingProfileCount: 0,
    missingProfileUploadIds: [],
    hasMissingProfiles: false
  }
};

function formatQty(value: number | null) {
  return value === null ? "Unknown" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function coverageLabel(status: CoverageStatus) {
  if (status === "in_stock") return "In stock";
  if (status === "partial_stock") return "Partial";
  if (status === "no_stock") return "No stock";
  if (status === "overstock") return "Overstock";
  return "Unknown";
}

function coverageClass(status: CoverageStatus) {
  if (status === "in_stock") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial_stock") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "no_stock") return "border-red-200 bg-red-50 text-red-700";
  if (status === "overstock") return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function sourceLabel(item: StockNeedsItem) {
  const upload = item.sourceUploads[0];
  if (!upload) return "Unknown";
  return upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId;
}

export default function AdminStockNeedsPage() {
  const [result, setResult] = useState<StockNeedsResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [customer, setCustomer] = useState("");
  const [partner, setPartner] = useState("");
  const [coverageStatus, setCoverageStatus] = useState<"" | CoverageStatus>("");
  const [uploadBatchId, setUploadBatchId] = useState("");

  const uploadOptions = useMemo(() => {
    const uploads = new Map<string, string>();
    for (const item of result.items) {
      for (const upload of item.sourceUploads) uploads.set(upload.uploadBatchId, upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId);
    }
    return Array.from(uploads.entries());
  }, [result.items]);

  async function loadData() {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (customer.trim()) params.set("customer", customer.trim());
    if (partner.trim()) {
      params.set("supplier", partner.trim());
      params.set("manufacturer", partner.trim());
    }
    if (coverageStatus) params.set("coverageStatus", coverageStatus);
    if (uploadBatchId) params.set("uploadBatchId", uploadBatchId);
    params.set("limit", "100");

    const response = await fetch(`/api/admin/stock-needs?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      setError("No se pudo cargar la vista de stock y necesidades.");
      setLoading(false);
      return;
    }
    setResult(await response.json() as StockNeedsResult);
    setLoading(false);
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summaryCards = [
    ["Total MPNs", result.totals.totalItems],
    ["In stock", result.totals.inStock],
    ["Partial stock", result.totals.partialStock],
    ["No stock", result.totals.noStock],
    ["Unknown", result.totals.unknown],
    ["Total required qty", formatQty(result.totals.totalRequiredQty)],
    ["Total stock qty", formatQty(result.totals.totalStockQty)]
  ];

  return (
    <AdminManagerGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin operations</p>
          <h1 className="text-2xl font-semibold text-slate-950">Client Needs & Company Stock</h1>
          <p className="text-sm text-slate-500">Necesidades del cliente y stock disponible por MPN, Item o Mfg Partno.</p>
        </div>

        {result.meta.hasMissingProfiles ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Este archivo todavia no tiene perfil estructural. Ejecuta <span className="font-mono">backfill:file-profiles</span>.
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          {summaryCards.map(([label, value]) => (
            <div key={label} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>

        <form
          className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void loadData();
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            MPN / Item
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input value={q} onChange={(event) => setQ(event.target.value)} className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 font-normal" placeholder="MPN, Item, Mfg Partno" />
            </div>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Cliente
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Proveedor / fabricante
            <input value={partner} onChange={(event) => setPartner(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Coverage
            <select value={coverageStatus} onChange={(event) => setCoverageStatus(event.target.value as "" | CoverageStatus)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              {COVERAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Archivo origen
            <select value={uploadBatchId} onChange={(event) => setUploadBatchId(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              <option value="">Todos</option>
              {uploadOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Aplicar
          </button>
        </form>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        <div className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">MPN / Item</th>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">Proveedor / fabricante</th>
                  <th className="px-4 py-3 text-right">Req qty</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3 text-right">Diferencia</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Fecha requerida</th>
                  <th className="px-4 py-3">Lead time</th>
                  <th className="px-4 py-3">Archivo origen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">Cargando stock y necesidades...</td></tr>
                ) : result.items.length ? result.items.map((item) => (
                  <tr key={item.mpn} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono font-semibold text-slate-950">{item.mpn}</td>
                    <td className="px-4 py-3 text-slate-700">{item.customerName ?? "Unknown"}</td>
                    <td className="px-4 py-3 text-slate-700">{item.supplierName ?? item.manufacturerName ?? "Unknown"}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.requiredQty)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.stockQty)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.shortageQty)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${coverageClass(item.coverageStatus)}`}>{coverageLabel(item.coverageStatus)}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{item.requiredDate ?? "Unknown"}</td>
                    <td className="px-4 py-3 text-slate-700">{item.leadTime ?? "Unknown"}</td>
                    <td className="max-w-xs px-4 py-3 text-slate-700">
                      <span className="block truncate">{sourceLabel(item)}</span>
                      {item.warnings.length ? <span className="mt-1 block text-xs text-amber-700">{item.warnings[0]}</span> : null}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">No hay MPNs que coincidan con los filtros actuales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminManagerGuard>
  );
}
