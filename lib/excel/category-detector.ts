import type { PlatformRecordColumns } from "@/lib/types";
import { normalizeHeader } from "@/lib/excel/header-detector";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";

const RULES: Record<string, string[]> = {
  "Sales Margin": ["cost", "price", "total price", "gp rate", "gp", "commission", "comision"],
  RFQ: ["line id", "req qty", "target to vendor", "potential amount usd", "qpddd", "plan item"],
  "Customer Demand": ["customer", "req qty", "plan item", "generic", "potential amount usd"],
  "Supplier Offers": [
    "supplier name",
    "best price offered",
    "mpn quoted",
    "manufacturer quoted",
    "date code",
    "moq",
    "spq"
  ],
  Logistics: [
    "delivery qto",
    "delivery next qto",
    "lead time",
    "transit time",
    "shipping point",
    "delivery point"
  ],
  Inventory: ["part number", "manufacturer", "qty", "stock", "warehouse", "on hand"],
  Quality: ["inspection", "authenticity", "visual inspection", "electrical test"],
  Finance: ["product cost", "gross margin", "net profit", "commission"]
};

export function detectCategory(
  headers: string[],
  columns?: PlatformRecordColumns,
  context?: LogContext
) {
  if (context) {
    void logger.debug({
      ...context,
      module: "category-detector",
      action: "category_detection_started",
      message: "Category detection started.",
      status: "started",
      metadata: { availableColumns: headers }
    });
  }

  const normalizedHeaders = headers.map(normalizeHeader).filter(Boolean);
  const scores = Object.entries(RULES).map(([category, keywords]) => {
    let score = 0;
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeHeader(keyword);
      if (normalizedHeaders.some((header) => header === normalizedKeyword)) score += 3;
      else if (normalizedHeaders.some((header) => header.includes(normalizedKeyword))) score += 1;
    }
    return { category, score };
  });

  if (columns) {
    if (columns.cost !== undefined && columns.price !== undefined && columns.gp_rate !== undefined) {
      scores.find((score) => score.category === "Sales Margin")!.score += 4;
    }
    if (columns.best_price_offered !== undefined && columns.mpn_quoted !== undefined) {
      scores.find((score) => score.category === "Supplier Offers")!.score += 4;
    }
    if (columns.lead_time_weeks !== undefined && columns.shipping_point_country !== undefined) {
      scores.find((score) => score.category === "Logistics")!.score += 3;
    }
  }

  const ranked = scores.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1]?.score ?? 0;
  const confidence = best.score <= 0 ? 0 : Math.min(1, best.score / Math.max(6, best.score + second));

  if (!best || best.score < 3 || confidence < 0.42) {
    if (context) {
      void logger.warn({
        ...context,
        module: "category-detector",
        action: "category_fallback_generic",
        message: "Category confidence was low; falling back to Generic.",
        status: "completed",
        category: "Generic",
        metadata: { confidence, scores }
      });
    }
    return { category: "Generic", confidence, scores };
  }

  if (context) {
    void logger.info({
      ...context,
      module: "category-detector",
      action: confidence < 0.5 ? "category_low_confidence" : "category_detected",
      message: "Category detected.",
      status: "completed",
      category: best.category,
      metadata: { detectedCategory: best.category, confidence, scores }
    });
  }

  return { category: best.category, confidence, scores };
}

export function detectDominantCategory(categories: string[]) {
  const counts = categories.reduce<Record<string, number>>((acc, category) => {
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});

  return (
    Object.entries(counts)
      .filter(([category]) => category !== "Generic")
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Generic"
  );
}
