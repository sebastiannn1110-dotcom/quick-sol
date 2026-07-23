"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import AdminManagerGuard from "@/components/AdminManagerGuard";
import type {
  OpportunityConfidenceLabel,
  OpportunityType,
  SalesOpportunitiesResult,
  SalesOpportunityItem
} from "@/lib/opportunities/opportunities";

const OPPORTUNITY_OPTIONS: Array<{ value: "" | OpportunityType; label: string }> = [
  { value: "", label: "All types" },
  { value: "immediate_sale", label: "Immediate sale" },
  { value: "partial_sale", label: "Partial sale" },
  { value: "excess_resale", label: "Excess resale" },
  { value: "sourcing_needed", label: "Sourcing needed" },
  { value: "stock_without_demand", label: "Stock without demand" }
];

const CONFIDENCE_OPTIONS: Array<{ value: "" | OpportunityConfidenceLabel; label: string }> = [
  { value: "", label: "All confidence" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" }
];

const EMPTY_RESULT: SalesOpportunitiesResult = {
  items: [],
  totals: {
    totalOpportunities: 0,
    immediateSale: 0,
    partialSale: 0,
    excessResale: 0,
    sourcingNeeded: 0,
    stockWithoutDemand: 0,
    approvedPartMatches: 0,
    receivedHistoryMatches: 0,
    highConfidence: 0,
    mediumConfidence: 0,
    lowConfidence: 0
  },
  meta: {
    limit: 50,
    offset: 0,
    returnedItems: 0,
    scannedRecords: 0,
    scannedUploads: 0,
    totalBeforePagination: 0
  }
};

function formatQty(value: number | null) {
  return value === null ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function typeLabel(type: OpportunityType) {
  if (type === "immediate_sale") return "Immediate sale";
  if (type === "partial_sale") return "Partial sale";
  if (type === "excess_resale") return "Excess resale";
  if (type === "sourcing_needed") return "Sourcing needed";
  return "Stock without demand";
}

function typeClass(type: OpportunityType) {
  if (type === "immediate_sale") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (type === "partial_sale") return "border-amber-200 bg-amber-50 text-amber-700";
  if (type === "excess_resale") return "border-sky-200 bg-sky-50 text-sky-700";
  if (type === "sourcing_needed") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function confidenceClass(label: OpportunityConfidenceLabel) {
  if (label === "high") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (label === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function sourceLabel(item: SalesOpportunityItem) {
  const names = item.sourceUploads.map((upload) => upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId).filter(Boolean);
  return names.length ? names.slice(0, 2).join(", ") : "Unknown";
}

function partnerLabel(item: SalesOpportunityItem) {
  return item.excessOwnerName ?? item.supplierName ?? item.manufacturerName ?? "Unknown";
}

export default function AdminOpportunitiesPage() {
  const [result, setResult] = useState<SalesOpportunitiesResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [customer, setCustomer] = useState("");
  const [partner, setPartner] = useState("");
  const [opportunityType, setOpportunityType] = useState<"" | OpportunityType>("");
  const [confidence, setConfidence] = useState<"" | OpportunityConfidenceLabel>("");
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
    if (opportunityType) params.set("opportunityType", opportunityType);
    if (confidence) params.set("confidence", confidence);
    if (uploadBatchId) params.set("uploadBatchId", uploadBatchId);
    params.set("limit", "100");

    const response = await fetch(`/api/admin/opportunities?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) {
      setError("No se pudo cargar Sales Opportunities.");
      setLoading(false);
      return;
    }
    setResult(await response.json() as SalesOpportunitiesResult);
    setLoading(false);
  }

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summaryCards = [
    ["Total opportunities", result.totals.totalOpportunities],
    ["Immediate sales", result.totals.immediateSale],
    ["Partial sales", result.totals.partialSale],
    ["Excess resale", result.totals.excessResale],
    ["Sourcing needed", result.totals.sourcingNeeded],
    ["Stock without demand", result.totals.stockWithoutDemand],
    ["High confidence", result.totals.highConfidence]
  ];

  return (
    <AdminManagerGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">Admin operations</p>
          <h1 className="text-2xl font-semibold text-slate-950">Sales Opportunities</h1>
          <p className="text-sm text-slate-500">MPN opportunities from stock, excess, approved parts and customer demand.</p>
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
          className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[1.2fr_1fr_1fr_1fr_1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void loadData();
          }}
        >
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Buscar MPN
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input value={q} onChange={(event) => setQ(event.target.value)} className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 font-normal" placeholder="001234, 1748917, ABC-001" />
            </div>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Cliente
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Proveedor/fabricante
            <input value={partner} onChange={(event) => setPartner(event.target.value)} className="rounded-md border border-slate-300 px-3 py-2 font-normal" />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Tipo
            <select value={opportunityType} onChange={(event) => setOpportunityType(event.target.value as "" | OpportunityType)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              {OPPORTUNITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Confianza
            <select value={confidence} onChange={(event) => setConfidence(event.target.value as "" | OpportunityConfidenceLabel)} className="rounded-md border border-slate-300 px-3 py-2 font-normal">
              {CONFIDENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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
                  <th className="px-4 py-3">Opportunity type</th>
                  <th className="px-4 py-3">MPN</th>
                  <th className="px-4 py-3">Customer need</th>
                  <th className="px-4 py-3">Source / supplier / excess owner</th>
                  <th className="px-4 py-3 text-right">Required qty</th>
                  <th className="px-4 py-3 text-right">Available qty</th>
                  <th className="px-4 py-3 text-right">Excess qty</th>
                  <th className="px-4 py-3 text-right">Shortage</th>
                  <th className="px-4 py-3">Approved</th>
                  <th className="px-4 py-3">Received history</th>
                  <th className="px-4 py-3">Confidence</th>
                  <th className="px-4 py-3">Recommended action</th>
                  <th className="px-4 py-3">Source uploads</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td colSpan={13} className="px-4 py-8 text-center text-slate-500">Cargando oportunidades...</td></tr>
                ) : result.items.length ? result.items.map((item) => (
                  <tr key={item.id} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${typeClass(item.opportunityType)}`}>{typeLabel(item.opportunityType)}</span>
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-950">{item.mpn}</td>
                    <td className="px-4 py-3 text-slate-700">{item.customerNeedName ?? "Unknown"}</td>
                    <td className="px-4 py-3 text-slate-700">{partnerLabel(item)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.requiredQty)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.availableQty)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.excessQty)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{formatQty(item.shortageQty)}</td>
                    <td className="px-4 py-3 text-slate-700">{item.approvedPartSignal ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-slate-700">{item.receivedSignal ? "Yes" : "No"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${confidenceClass(item.confidenceLabel)}`}>{item.confidenceLabel} {item.confidenceScore}</span>
                    </td>
                    <td className="min-w-64 px-4 py-3 text-slate-700">{item.recommendedAction}</td>
                    <td className="max-w-xs px-4 py-3 text-slate-700">
                      <span className="block truncate">{sourceLabel(item)}</span>
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={13} className="px-4 py-8 text-center text-slate-500">No hay oportunidades que coincidan con los filtros actuales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AdminManagerGuard>
  );
}
