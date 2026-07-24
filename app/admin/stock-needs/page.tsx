"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import AdminManagerGuard from "@/components/AdminManagerGuard";
import { useLanguage } from "@/components/LanguageProvider";
import type { Language } from "@/lib/i18n";
import type { CoverageStatus, StockNeedsItem, StockNeedsResult } from "@/lib/stock-needs/stock-needs";

const COPY = {
  es: {
    adminEyebrow: "Operaciones administrativas",
    eyebrow: "Operaciones comerciales",
    title: "Stock y necesidades",
    description: "Necesidades de clientes y stock disponible por MPN.",
    error: "No se pudo cargar la vista de stock y necesidades.",
    total: "MPN totales",
    inStock: "Con stock",
    partial: "Stock parcial",
    noStock: "Sin stock",
    overstock: "Exceso",
    unknown: "Desconocido",
    requiredTotal: "Cantidad total requerida",
    stockTotal: "Cantidad total en stock",
    allCoverage: "Toda cobertura",
    customer: "Cliente",
    partner: "Proveedor o fabricante",
    coverage: "Cobertura",
    source: "Archivo de origen",
    all: "Todos",
    apply: "Aplicar",
    required: "Cantidad requerida",
    stock: "Stock",
    shortage: "Faltante",
    status: "Estado",
    requiredDate: "Fecha requerida",
    leadTime: "Plazo de entrega",
    loading: "Cargando stock y necesidades...",
    empty: "No hay MPN que coincidan con los filtros actuales."
  },
  en: {
    adminEyebrow: "Administrative operations",
    eyebrow: "Commercial operations",
    title: "Stock and Needs",
    description: "Client needs and available stock by MPN.",
    error: "Unable to load stock and needs.",
    total: "Total MPNs",
    inStock: "In stock",
    partial: "Partial stock",
    noStock: "No stock",
    overstock: "Overstock",
    unknown: "Unknown",
    requiredTotal: "Total required quantity",
    stockTotal: "Total stock quantity",
    allCoverage: "All coverage",
    customer: "Client",
    partner: "Supplier or manufacturer",
    coverage: "Coverage",
    source: "Source file",
    all: "All",
    apply: "Apply",
    required: "Required quantity",
    stock: "Stock",
    shortage: "Shortage",
    status: "Status",
    requiredDate: "Required date",
    leadTime: "Lead time",
    loading: "Loading stock and needs...",
    empty: "No MPNs match the current filters."
  },
  zh: {
    adminEyebrow: "管理操作",
    eyebrow: "商业操作",
    title: "库存与需求",
    description: "按 MPN 查看客户需求和可用库存。",
    error: "无法加载库存与需求。",
    total: "MPN 总数",
    inStock: "有库存",
    partial: "部分库存",
    noStock: "无库存",
    overstock: "库存过剩",
    unknown: "未知",
    requiredTotal: "需求总量",
    stockTotal: "库存总量",
    allCoverage: "全部覆盖状态",
    customer: "客户",
    partner: "供应商或制造商",
    coverage: "覆盖状态",
    source: "来源文件",
    all: "全部",
    apply: "应用",
    required: "需求数量",
    stock: "库存",
    shortage: "缺口",
    status: "状态",
    requiredDate: "需求日期",
    leadTime: "交货期",
    loading: "正在加载库存与需求...",
    empty: "没有符合当前筛选条件的 MPN。"
  }
} satisfies Record<Language, Record<string, string>>;

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

function formatQty(value: number | null, locale: string, unknown: string) {
  return value === null ? unknown : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value));
}

function coverageLabel(status: CoverageStatus, copy: typeof COPY.es) {
  if (status === "in_stock") return copy.inStock;
  if (status === "partial_stock") return copy.partial;
  if (status === "no_stock") return copy.noStock;
  if (status === "overstock") return copy.overstock;
  return copy.unknown;
}

function coverageClass(status: CoverageStatus) {
  if (status === "in_stock") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial_stock") return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "no_stock") return "border-red-200 bg-red-50 text-red-700";
  if (status === "overstock") return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function sourceLabel(item: StockNeedsItem, unknown: string) {
  const upload = item.sourceUploads[0];
  if (!upload) return unknown;
  return upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId;
}

export function StockNeedsDashboard({
  endpoint = "/api/admin/stock-needs",
  adminMode = true
}: {
  endpoint?: string;
  adminMode?: boolean;
}) {
  const { language, locale } = useLanguage();
  const copy = COPY[language];
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

    const response = await fetch(`${endpoint}?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      setError(copy.error);
      setLoading(false);
      return;
    }
    setResult(await response.json() as StockNeedsResult);
    setLoading(false);
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, language]);

  const coverageOptions: Array<{ value: "" | CoverageStatus; label: string }> = [
    { value: "", label: copy.allCoverage },
    { value: "in_stock", label: copy.inStock },
    { value: "partial_stock", label: copy.partial },
    { value: "no_stock", label: copy.noStock },
    { value: "overstock", label: copy.overstock },
    { value: "unknown", label: copy.unknown }
  ];

  const summaryCards = [
    [copy.total, result.totals.totalItems],
    [copy.inStock, result.totals.inStock],
    [copy.partial, result.totals.partialStock],
    [copy.noStock, result.totals.noStock],
    [copy.unknown, result.totals.unknown],
    [copy.requiredTotal, formatQty(result.totals.totalRequiredQty, locale, copy.unknown)],
    [copy.stockTotal, formatQty(result.totals.totalStockQty, locale, copy.unknown)]
  ];

  return (
    <div className="space-y-6">
        <div>
          <p className={`text-sm font-medium ${adminMode ? "text-orange-700" : "text-brand-700"}`}>{adminMode ? copy.adminEyebrow : copy.eyebrow}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{copy.title}</h1>
          <p className="text-sm text-slate-500">{copy.description}</p>
        </div>

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
            {copy.customer}
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {copy.partner}
            <input value={partner} onChange={(event) => setPartner(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {copy.coverage}
            <select value={coverageStatus} onChange={(event) => setCoverageStatus(event.target.value as "" | CoverageStatus)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              {coverageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {copy.source}
            <select value={uploadBatchId} onChange={(event) => setUploadBatchId(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              <option value="">{copy.all}</option>
              {uploadOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 self-end rounded-md bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {copy.apply}
          </button>
        </form>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div> : null}

        <div className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">MPN / Item</th>
                  <th className="px-4 py-3">{copy.customer}</th>
                  <th className="px-4 py-3">{copy.partner}</th>
                  <th className="px-4 py-3 text-right">{copy.required}</th>
                  <th className="px-4 py-3 text-right">{copy.stock}</th>
                  <th className="px-4 py-3 text-right">{copy.shortage}</th>
                  <th className="px-4 py-3">{copy.status}</th>
                  <th className="px-4 py-3">{copy.requiredDate}</th>
                  <th className="px-4 py-3">{copy.leadTime}</th>
                  <th className="px-4 py-3">{copy.source}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">{copy.loading}</td></tr>
                ) : result.items.length ? result.items.map((item) => (
                  <tr key={item.mpn} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono font-semibold text-slate-950">{item.mpn}</td>
                    <td className="px-4 py-3 text-slate-700">{item.customerName ?? copy.unknown}</td>
                    <td className="px-4 py-3 text-slate-700">{item.supplierName ?? item.manufacturerName ?? copy.unknown}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.requiredQty, locale, copy.unknown)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.stockQty, locale, copy.unknown)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.shortageQty, locale, copy.unknown)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${coverageClass(item.coverageStatus)}`}>{coverageLabel(item.coverageStatus, copy)}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{item.requiredDate ?? copy.unknown}</td>
                    <td className="px-4 py-3 text-slate-700">{item.leadTime ?? copy.unknown}</td>
                    <td className="max-w-xs px-4 py-3 text-slate-700">
                      <span className="block truncate">{sourceLabel(item, copy.unknown)}</span>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">{copy.empty}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
    </div>
  );
}

export default function AdminStockNeedsPage() {
  return (
    <AdminManagerGuard>
      <StockNeedsDashboard />
    </AdminManagerGuard>
  );
}
