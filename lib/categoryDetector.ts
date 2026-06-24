import type { BusinessCategory, CategoryDetectionResult } from "@/lib/types";
import { cleanHeader } from "@/lib/validators";

const CATEGORY_KEYWORDS: Partial<Record<BusinessCategory, string[]>> = {
  Inventory: [
    "part number",
    "pn",
    "mpn",
    "manufacturer",
    "quantity",
    "qty",
    "stock",
    "warehouse",
    "date code",
    "moq",
    "lead time"
  ],
  Customers: [
    "customer",
    "company",
    "contact",
    "credit terms",
    "assigned salesperson",
    "customer priority",
    "industry"
  ],
  Suppliers: [
    "supplier",
    "supplier name",
    "reliability",
    "delivery time",
    "payment terms",
    "certifications",
    "risk level"
  ],
  RFQ: [
    "rfq",
    "rfq id",
    "quoted price",
    "target price",
    "quantity requested",
    "date requested",
    "deadline"
  ],
  Orders: [
    "order id",
    "order",
    "invoice",
    "payment status",
    "shipping status",
    "quantity sold",
    "total sale"
  ],
  Logistics: [
    "shipment",
    "shipment id",
    "tracking",
    "carrier",
    "origin",
    "destination",
    "customs",
    "estimated arrival"
  ],
  "Quality Inspection": [
    "inspection",
    "inspection id",
    "authenticity",
    "visual inspection",
    "electrical test",
    "inspector",
    "final status",
    "batch lot"
  ],
  "Market Insights": [
    "market trend",
    "shortage risk",
    "forecast",
    "demand level",
    "average price",
    "source",
    "updated date"
  ],
  Finance: [
    "margin",
    "gross margin",
    "profit",
    "net profit",
    "cost",
    "commission",
    "currency",
    "exchange rate"
  ],
  Employees: [
    "employee",
    "employee name",
    "department",
    "region",
    "role",
    "monthly sales",
    "performance score",
    "tasks pending"
  ],
  Unknown: []
};

export function detectCategoryFromHeaders(headers: string[]): CategoryDetectionResult {
  const normalizedHeaders = headers.map(cleanHeader).filter(Boolean);
  const scores: Partial<Record<BusinessCategory, number>> = {};

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [
    BusinessCategory,
    string[]
  ][]) {
    if (category === "Unknown") continue;

    let score = 0;
    for (const header of normalizedHeaders) {
      for (const keyword of keywords) {
        if (header === keyword) {
          score += 3;
        } else if (header.includes(keyword) || keyword.includes(header)) {
          score += 1;
        }
      }
    }
    scores[category] = score;
  }

  const ranked = Object.entries(scores).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const [bestCategory, bestScore = 0] = ranked[0] ?? ["Unknown", 0];
  const nextScore = ranked[1]?.[1] ?? 0;
  const confidence = bestScore <= 0 ? 0 : Math.min(1, bestScore / Math.max(5, bestScore + nextScore));

  if (bestScore < 3 || confidence < 0.45) {
    return {
      category: "Unknown",
      confidence,
      scores
    };
  }

  return {
    category: bestCategory as BusinessCategory,
    confidence,
    scores
  };
}

export function detectDominantCategory(categories: BusinessCategory[]) {
  const counts = categories.reduce<Partial<Record<BusinessCategory, number>>>((acc, category) => {
    acc[category] = (acc[category] ?? 0) + 1;
    return acc;
  }, {});

  const [category] =
    Object.entries(counts)
      .filter(([key]) => key !== "Unknown")
      .sort((a, b) => b[1] - a[1])[0] ?? [];

  return (category as BusinessCategory | undefined) ?? "Unknown";
}
