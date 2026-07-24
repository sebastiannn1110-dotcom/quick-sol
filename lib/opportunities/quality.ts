import type {
  SalesOpportunitiesResult,
  SalesOpportunityItem
} from "@/lib/opportunities/opportunities";

export type OpportunityConfidenceLabel = "high" | "medium" | "low";

export type SalesOpportunityWithConfidence = SalesOpportunityItem & {
  confidenceScore: number;
  confidenceLabel: OpportunityConfidenceLabel;
};

export type SalesOpportunitiesWithConfidenceResult = Omit<SalesOpportunitiesResult, "items" | "totals" | "meta"> & {
  items: SalesOpportunityWithConfidence[];
  totals: SalesOpportunitiesResult["totals"] & {
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
  };
  meta: SalesOpportunitiesResult["meta"] & {
    confidenceEvaluatedItems: number;
    confidenceTruncated: boolean;
  };
};

function positiveQuantity(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function scoreOpportunityConfidence(item: SalesOpportunityItem) {
  let score = 30;
  if (item.normalizedMpn) score += 10;
  if (positiveQuantity(item.requiredQty)) score += 10;
  if (positiveQuantity(item.availableQty) || positiveQuantity(item.excessQty)) score += 10;
  if (positiveQuantity(item.shortageQty)) score += 5;
  if (item.customerNeedName || item.accountClients.length) score += 10;
  if (item.supplierName || item.manufacturerName || item.excessOwnerName) score += 5;
  if (item.approvedPartSignal) score += 10;
  if (item.receivedSignal) score += 5;
  if (item.sourceUploads.length > 1) score += 5;
  score -= Math.min(item.dataQualityFlags.length * 5, 20);
  return Math.min(Math.max(score, 0), 100);
}

export function confidenceLabel(score: number): OpportunityConfidenceLabel {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

export function enrichOpportunitiesWithConfidence(
  result: SalesOpportunitiesResult,
  confidence?: OpportunityConfidenceLabel | null
): SalesOpportunitiesWithConfidenceResult {
  const scored = result.items.map((item) => {
    const confidenceScore = scoreOpportunityConfidence(item);
    return { ...item, confidenceScore, confidenceLabel: confidenceLabel(confidenceScore) };
  });
  const items = confidence ? scored.filter((item) => item.confidenceLabel === confidence) : scored;

  return {
    ...result,
    items,
    totals: {
      ...result.totals,
      highConfidence: scored.filter((item) => item.confidenceLabel === "high").length,
      mediumConfidence: scored.filter((item) => item.confidenceLabel === "medium").length,
      lowConfidence: scored.filter((item) => item.confidenceLabel === "low").length
    },
    meta: {
      ...result.meta,
      returnedItems: items.length,
      confidenceEvaluatedItems: scored.length,
      confidenceTruncated: result.meta.totalBeforePagination > scored.length
    }
  };
}

export function summarizeOpportunityConfidence(result: SalesOpportunitiesWithConfidenceResult) {
  const scope = result.meta.confidenceTruncated ? " en la muestra consultada" : "";
  return `Encontré ${result.totals.highConfidence} oportunidades de alta confianza, ${result.totals.mediumConfidence} de confianza media y ${result.totals.lowConfidence} de baja confianza${scope}.`;
}
