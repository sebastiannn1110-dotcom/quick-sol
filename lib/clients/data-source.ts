import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSalesOpportunitiesResult, type SalesOpportunitiesResult } from "@/lib/opportunities/opportunities";
import { enrichOpportunitiesWithConfidence } from "@/lib/opportunities/quality";
import { loadStockNeedsInput } from "@/lib/stock-needs/data-source";
import { normalizePartNumberForMatch } from "@/lib/stock-needs/stock-needs";
import type { UserRole } from "@/lib/types";
import {
  type AccountClient,
  type ClientDetail,
  type ClientPrivateDetails,
  type ClientStatus,
  type ClientUpload,
  clientCapabilities
} from "@/lib/clients/clients";

const CLIENT_SELECT = "id,name,description,industry,region,website,logo_path,status,created_at,updated_at,archived_at";
const ASSIGNMENT_SELECT = "id,client_id,upload_batch_id,assigned_at,upload_batches(id,original_file_name,detected_category,status,total_rows,warning_count,created_at,archived_at)";

type ClientRow = {
  id: string;
  name: string;
  description: string | null;
  industry: string | null;
  region: string | null;
  website: string | null;
  logo_path: string | null;
  status: ClientStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type AssignmentRow = {
  id?: string;
  client_id: string;
  upload_batch_id: string;
  assigned_at: string;
  upload_batches?: {
    id: string;
    original_file_name: string;
    detected_category: string | null;
    status: string;
    total_rows: number | null;
    warning_count: number | null;
    created_at: string;
    archived_at: string | null;
  } | null;
};

type ClientPrivateImageRow = {
  client_id: string;
  identification_image_path: string | null;
};

type ClientListOptions = {
  clientId?: string | null;
  includeArchived?: boolean;
  limit?: number;
};

async function loadClientRows(supabase: SupabaseClient, options: ClientListOptions) {
  let query = supabase
    .from("clients")
    .select(CLIENT_SELECT)
    .order("name", { ascending: true })
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 200));

  if (options.clientId) query = query.eq("id", options.clientId);
  if (!options.includeArchived) query = query.is("archived_at", null).eq("status", "active");

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ClientRow[];
}

async function loadAssignments(supabase: SupabaseClient, clientIds: string[]) {
  if (!clientIds.length) return [] as AssignmentRow[];
  const rows: AssignmentRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("client_upload_assignments")
      .select(ASSIGNMENT_SELECT)
      .in("client_id", clientIds)
      .order("assigned_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    const page = (data ?? []) as unknown as AssignmentRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function loadAuthorizedIdentificationImagePaths(
  supabase: SupabaseClient,
  clientIds: string[],
  canViewPrivateIdentification: boolean
) {
  if (!canViewPrivateIdentification || !clientIds.length) {
    return new Map<string, string | null>();
  }

  const { data, error } = await supabase
    .from("client_private_details")
    .select("client_id,identification_image_path")
    .in("client_id", clientIds);
  if (error) throw error;

  return new Map(
    ((data ?? []) as ClientPrivateImageRow[]).map((row) => [
      row.client_id,
      row.identification_image_path
    ])
  );
}

function assignmentsForClient(assignments: AssignmentRow[], clientId: string) {
  return assignments.filter((assignment) =>
    assignment.client_id === clientId &&
    assignment.upload_batches &&
    !assignment.upload_batches.archived_at &&
    assignment.upload_batches.status !== "archived"
  );
}

function opportunityMetrics(result: SalesOpportunitiesResult) {
  const confidence = enrichOpportunitiesWithConfidence(result);
  return {
    opportunity_count: result.totals.totalOpportunities,
    immediate_sale_count: result.totals.immediateSale,
    partial_sale_count: result.totals.partialSale,
    sourcing_needed_count: result.totals.sourcingNeeded,
    stock_without_demand_count: result.totals.stockWithoutDemand,
    high_confidence_count: confidence.totals.highConfidence,
    high_confidence_truncated: confidence.meta.confidenceTruncated
  };
}

export async function listClientSummaries(
  supabase: SupabaseClient,
  role: UserRole,
  options: ClientListOptions = {}
): Promise<AccountClient[]> {
  const clients = await loadClientRows(supabase, options);
  const capabilities = clientCapabilities(role);
  const clientIds = clients.map((client) => client.id);
  const [assignments, identificationImagePaths, metricsResult] = await Promise.all([
    loadAssignments(supabase, clientIds),
    loadAuthorizedIdentificationImagePaths(supabase, clientIds, capabilities.canViewPrivateIdentification),
    clientIds.length ? supabase.rpc("get_client_business_metrics_v1", { target_client_ids: clientIds }) : Promise.resolve({ data: [], error: null })
  ]);
  if (metricsResult.error && !["PGRST202", "42883"].includes(metricsResult.error.code ?? "")) throw metricsResult.error;
  const metrics = new Map(((metricsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.client_id), row]));
  const summariesReady = !metricsResult.error && clientIds.every((id) => metrics.get(id)?.summary_ready === true);
  if (!summariesReady) {
    const visibleUploadIds = Array.from(new Set(assignments
      .filter((assignment) => assignment.upload_batches && !assignment.upload_batches.archived_at && assignment.upload_batches.status !== "archived")
      .map((assignment) => assignment.upload_batch_id)));
    const input = visibleUploadIds.length
      ? await loadStockNeedsInput(supabase, { uploadIds: visibleUploadIds, complete: true })
      : { records: [], profiles: [], importJobs: [], uploadIds: [] };
    for (const client of clients) {
      const uploads = new Set(assignmentsForClient(assignments, client.id).map((assignment) => assignment.upload_batch_id));
      const records = input.records.filter((record) => uploads.has(record.upload_batch_id));
      const result = buildSalesOpportunitiesResult({
        records,
        profiles: input.profiles.filter((profile) => uploads.has(profile.upload_batch_id)),
        importJobs: input.importJobs.filter((job) => uploads.has(job.upload_batch_id)),
        filters: { limit: 200 },
        includeAllItems: true
      });
      metrics.set(client.id, {
        client_id: client.id,
        mpn_count: new Set(records.map((record) => normalizePartNumberForMatch(record.mpn ?? record.mpn_quoted)).filter(Boolean)).size,
        ...opportunityMetrics(result),
        summary_ready: false
      });
    }
  }

  return clients.map((client) => {
    const clientAssignments = assignmentsForClient(assignments, client.id);
    const metric = metrics.get(client.id);

    return {
      id: client.id,
      name: client.name,
      description: client.description,
      industry: client.industry,
      region: client.region,
      website: client.website,
      logoUrl: client.logo_path ? `/api/clients/${client.id}/image?kind=logo` : null,
      authorizedIdentificationImageUrl: identificationImagePaths.get(client.id)
        ? `/api/clients/${client.id}/image?kind=identification`
        : null,
      status: client.status,
      fileCount: clientAssignments.length,
      mpnCount: Number(metric?.mpn_count ?? 0),
      opportunityCount: Number(metric?.opportunity_count ?? 0),
      immediateSaleCount: Number(metric?.immediate_sale_count ?? 0),
      partialSaleCount: Number(metric?.partial_sale_count ?? 0),
      sourcingNeededCount: Number(metric?.sourcing_needed_count ?? 0),
      stockWithoutDemandCount: Number(metric?.stock_without_demand_count ?? 0),
      highConfidenceCount: Number(metric?.high_confidence_count ?? 0),
      highConfidenceTruncated: Boolean(metric?.high_confidence_truncated ?? false),
      createdAt: client.created_at,
      updatedAt: client.updated_at,
      canManage: capabilities.canManage
    };
  });
}

export async function getClientDetail(
  supabase: SupabaseClient,
  role: UserRole,
  clientId: string
): Promise<ClientDetail | null> {
  const [client] = await listClientSummaries(supabase, role, { clientId, includeArchived: role !== "employee", limit: 1 });
  if (!client) return null;

  let privateDetails: ClientPrivateDetails | null = null;
  if (clientCapabilities(role).canViewPrivateIdentification) {
    const { data } = await supabase
      .from("client_private_details")
      .select("internal_notes")
      .eq("client_id", clientId)
      .maybeSingle();
    privateDetails = {
      identificationImageUrl: client.authorizedIdentificationImageUrl,
      internalNotes: data?.internal_notes ?? null
    };
  }

  return { ...client, privateDetails };
}

export async function listClientUploadIds(supabase: SupabaseClient, clientId: string) {
  const assignments = await loadAssignments(supabase, [clientId]);
  return assignmentsForClient(assignments, clientId).map((assignment) => assignment.upload_batch_id);
}

export async function listClientUploads(supabase: SupabaseClient, clientId: string): Promise<ClientUpload[]> {
  const assignments = await loadAssignments(supabase, [clientId]);
  return assignmentsForClient(assignments, clientId).map((assignment) => {
    const upload = assignment.upload_batches!;
    return {
      id: upload.id,
      originalFileName: upload.original_file_name,
      detectedCategory: upload.detected_category,
      status: upload.status,
      totalRows: Number(upload.total_rows ?? 0),
      warningCount: Number(upload.warning_count ?? 0),
      createdAt: upload.created_at,
      assignedAt: assignment.assigned_at
    };
  });
}
