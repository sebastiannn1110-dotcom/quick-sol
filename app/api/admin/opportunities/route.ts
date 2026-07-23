import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/context";
import {
  buildSalesOpportunitiesResult,
  type OpportunityConfidenceLabel,
  type OpportunityType,
  type SalesOpportunityFilters
} from "@/lib/opportunities/opportunities";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";
import { loadStockNeedsInput } from "@/lib/stock-needs/data-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPPORTUNITY_TYPES = new Set<OpportunityType>([
  "immediate_sale",
  "partial_sale",
  "excess_resale",
  "sourcing_needed",
  "stock_without_demand"
]);

const CONFIDENCE_LABELS = new Set<OpportunityConfidenceLabel>(["high", "medium", "low"]);

function cleanText(value: string | null, max = 120) {
  const text = value?.replace(/[^\p{L}\p{N}\s._@/-]/gu, " ").replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, max) : null;
}

function cleanUuid(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value) ? value : null;
}

function parseFilters(request: Request): SalesOpportunityFilters {
  const searchParams = new URL(request.url).searchParams;
  const rawType = cleanText(searchParams.get("opportunityType"), 60);
  const opportunityType = rawType && OPPORTUNITY_TYPES.has(rawType as OpportunityType) ? rawType as OpportunityType : null;
  const rawConfidence = cleanText(searchParams.get("confidence"), 20);
  const confidence = rawConfidence && CONFIDENCE_LABELS.has(rawConfidence as OpportunityConfidenceLabel) ? rawConfidence as OpportunityConfidenceLabel : null;

  return {
    q: cleanText(searchParams.get("q")),
    mpn: cleanText(searchParams.get("mpn")),
    customer: cleanText(searchParams.get("customer")),
    supplier: cleanText(searchParams.get("supplier")),
    manufacturer: cleanText(searchParams.get("manufacturer")),
    opportunityType,
    confidence,
    uploadBatchId: cleanUuid(searchParams.get("uploadBatchId")),
    limit: Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200),
    offset: Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0)
  };
}

export async function GET(request: Request) {
  const context = await requireRole(request, ["admin", "manager"]);
  if (context instanceof NextResponse) return context;

  const filters = parseFilters(request);
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json(redactSensitiveFieldsForRole(buildSalesOpportunitiesResult({ records: [], filters }), context.profile.role));
  }

  try {
    const input = await loadStockNeedsInput(context.supabase, {
      filters: { uploadBatchId: filters.uploadBatchId },
      maxUploads: 30,
      recordsPerUploadLimit: filters.uploadBatchId ? 10000 : 5000
    });

    const result = buildSalesOpportunitiesResult({
      records: input.records,
      profiles: input.profiles,
      importJobs: input.importJobs,
      filters
    });

    return NextResponse.json(redactSensitiveFieldsForRole(result, context.profile.role));
  } catch {
    return NextResponse.json({ error: "Unable to load sales opportunities." }, { status: 500 });
  }
}
