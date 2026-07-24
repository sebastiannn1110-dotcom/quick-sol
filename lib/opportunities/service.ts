import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientDetail, listClientUploadIds } from "@/lib/clients/data-source";
import {
  buildSalesOpportunitiesResult,
  type OpportunityType,
  type SalesOpportunitiesResult,
  type SalesOpportunityFilters
} from "@/lib/opportunities/opportunities";
import {
  enrichOpportunitiesWithConfidence,
  type OpportunityConfidenceLabel
} from "@/lib/opportunities/quality";
import { loadStockNeedsInput } from "@/lib/stock-needs/data-source";
import type { UserRole } from "@/lib/types";

const OPPORTUNITY_TYPES = new Set<OpportunityType>([
  "immediate_sale",
  "partial_sale",
  "excess_resale",
  "sourcing_needed",
  "stock_without_demand"
]);
const CONFIDENCE_LABELS = new Set<OpportunityConfidenceLabel>(["high", "medium", "low"]);

export type SalesOpportunityRequestFilters = SalesOpportunityFilters & {
  confidence?: OpportunityConfidenceLabel | null;
};

type AssignmentClientRow = {
  upload_batch_id: string;
  client_id: string;
  clients?: { id: string; name: string } | null;
};

function cleanText(value: string | null, max = 120) {
  const text = value?.replace(/[^\p{L}\p{N}\s._@/-]/gu, " ").replace(/\s+/g, " ").trim() ?? "";
  return text ? text.slice(0, max) : null;
}

function cleanUuid(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function parseSalesOpportunityFilters(request: Request): SalesOpportunityRequestFilters {
  const searchParams = new URL(request.url).searchParams;
  const rawType = cleanText(searchParams.get("opportunityType"), 60);
  const rawConfidence = cleanText(searchParams.get("confidence"), 20);

  return {
    q: cleanText(searchParams.get("q")),
    mpn: cleanText(searchParams.get("mpn")),
    clientId: cleanUuid(searchParams.get("clientId")),
    customer: cleanText(searchParams.get("customer")),
    supplier: cleanText(searchParams.get("supplier")),
    manufacturer: cleanText(searchParams.get("manufacturer")),
    opportunityType: rawType && OPPORTUNITY_TYPES.has(rawType as OpportunityType) ? rawType as OpportunityType : null,
    confidence: rawConfidence && CONFIDENCE_LABELS.has(rawConfidence as OpportunityConfidenceLabel)
      ? rawConfidence as OpportunityConfidenceLabel
      : null,
    uploadBatchId: cleanUuid(searchParams.get("uploadBatchId")),
    limit: Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200),
    offset: Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0)
  };
}

async function loadAccountClientAssignments(supabase: SupabaseClient, uploadIds: string[]) {
  if (!uploadIds.length) return [] as AssignmentClientRow[];
  const { data, error } = await supabase
    .from("client_upload_assignments")
    .select("upload_batch_id,client_id,clients(id,name)")
    .in("upload_batch_id", uploadIds);
  if (error) throw error;
  return (data ?? []) as unknown as AssignmentClientRow[];
}

function attachAccountClients(result: SalesOpportunitiesResult, assignments: AssignmentClientRow[]) {
  const byUpload = new Map<string, Array<{ id: string; name: string }>>();
  for (const assignment of assignments) {
    const client = assignment.clients;
    if (!client) continue;
    const existing = byUpload.get(assignment.upload_batch_id) ?? [];
    if (!existing.some((item) => item.id === client.id)) existing.push(client);
    byUpload.set(assignment.upload_batch_id, existing);
  }

  return {
    ...result,
    items: result.items.map((item) => {
      const clients = new Map<string, { id: string; name: string }>();
      for (const upload of item.sourceUploads) {
        for (const client of byUpload.get(upload.uploadBatchId) ?? []) clients.set(client.id, client);
      }
      return { ...item, accountClients: Array.from(clients.values()) };
    })
  };
}

export async function loadSalesOpportunities(
  supabase: SupabaseClient,
  role: UserRole,
  filters: SalesOpportunityRequestFilters
) {
  let uploadIds: string[] | undefined;
  if (filters.clientId) {
    const client = await getClientDetail(supabase, role, filters.clientId);
    if (!client) return null;
    uploadIds = await listClientUploadIds(supabase, filters.clientId);
  }

  const input = await loadStockNeedsInput(supabase, {
    filters: { uploadBatchId: filters.uploadBatchId },
    uploadIds,
    maxUploads: uploadIds ? Math.min(Math.max(uploadIds.length, 1), 50) : 30,
    recordsPerUploadLimit: filters.uploadBatchId ? 10000 : 5000
  });
  const result = buildSalesOpportunitiesResult({
    records: input.records,
    profiles: input.profiles,
    importJobs: input.importJobs,
    filters
  });
  const assignments = await loadAccountClientAssignments(supabase, input.uploadIds);
  return enrichOpportunitiesWithConfidence(attachAccountClients(result, assignments), filters.confidence);
}
