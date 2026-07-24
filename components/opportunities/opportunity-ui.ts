import type {
  OpportunityType,
  SalesOpportunityItem
} from "@/lib/opportunities/opportunities";
import type {
  OpportunityConfidenceLabel,
  SalesOpportunitiesWithConfidenceResult
} from "@/lib/opportunities/quality";

export const EMPTY_OPPORTUNITIES_RESULT: SalesOpportunitiesWithConfidenceResult = {
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
    totalBeforePagination: 0,
    confidenceEvaluatedItems: 0,
    confidenceTruncated: false
  }
};

export function formatOpportunityQuantity(value: number | null, locale: string) {
  return value === null ? "-" : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value));
}

export function opportunityTypeClass(type: OpportunityType) {
  if (type === "immediate_sale") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (type === "partial_sale") return "border-amber-200 bg-amber-50 text-amber-700";
  if (type === "excess_resale") return "border-sky-200 bg-sky-50 text-sky-700";
  if (type === "sourcing_needed") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export function confidenceClass(label: OpportunityConfidenceLabel) {
  if (label === "high") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (label === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export function opportunitySourceLabel(item: SalesOpportunityItem) {
  const names = item.sourceUploads
    .map((upload) => upload.fileName ?? upload.detectedTemplate ?? upload.uploadBatchId)
    .filter(Boolean);
  return names.length ? names.slice(0, 2).join(", ") : "-";
}

export function opportunityPartnerLabel(item: SalesOpportunityItem) {
  return item.excessOwnerName ?? item.supplierName ?? item.manufacturerName ?? "-";
}

export function accountClientLabel(item: SalesOpportunityItem) {
  return item.accountClients.length ? item.accountClients.map((client) => client.name).join(", ") : "-";
}

export function opportunityActionKey(type: OpportunityType) {
  if (type === "immediate_sale") return "opportunities.action.immediate" as const;
  if (type === "partial_sale") return "opportunities.action.partial" as const;
  if (type === "excess_resale") return "opportunities.action.excess" as const;
  if (type === "sourcing_needed") return "opportunities.action.sourcing" as const;
  return "opportunities.action.stockWithoutDemand" as const;
}

export function opportunityTypeKey(type: OpportunityType) {
  if (type === "immediate_sale") return "opportunities.type.immediate" as const;
  if (type === "partial_sale") return "opportunities.type.partial" as const;
  if (type === "excess_resale") return "opportunities.type.excess" as const;
  if (type === "sourcing_needed") return "opportunities.type.sourcing" as const;
  return "opportunities.type.stockWithoutDemand" as const;
}

export function opportunityConfidenceKey(label: OpportunityConfidenceLabel) {
  if (label === "high") return "opportunities.confidence.high" as const;
  if (label === "medium") return "opportunities.confidence.medium" as const;
  return "opportunities.confidence.low" as const;
}
