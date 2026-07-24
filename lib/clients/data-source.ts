import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSalesOpportunitiesResult,
  type SalesOpportunitiesResult
} from "@/lib/opportunities/opportunities";
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
const ASSIGNMENT_SELECT = "client_id,upload_batch_id,assigned_at,upload_batches(id,original_file_name,detected_category,status,total_rows,warning_count,created_at,archived_at)";

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

type ClientListOptions = {
  clientId?: string | null;
  includeArchived?: boolean;
  limit?: number;
};

async function signedAssetUrl(supabase: SupabaseClient, path: string | null) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from("client-assets").createSignedUrl(path, 3600);
  return error ? null : data.signedUrl;
}

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
  const { data, error } = await supabase
    .from("client_upload_assignments")
    .select(ASSIGNMENT_SELECT)
    .in("client_id", clientIds)
    .order("assigned_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as AssignmentRow[];
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
    opportunityCount: result.totals.totalOpportunities,
    immediateSaleCount: result.totals.immediateSale,
    partialSaleCount: result.totals.partialSale,
    sourcingNeededCount: result.totals.sourcingNeeded,
    stockWithoutDemandCount: result.totals.stockWithoutDemand,
    highConfidenceCount: confidence.totals.highConfidence,
    highConfidenceTruncated: confidence.meta.confidenceTruncated
  };
}

export async function listClientSummaries(
  supabase: SupabaseClient,
  role: UserRole,
  options: ClientListOptions = {}
): Promise<AccountClient[]> {
  const clients = await loadClientRows(supabase, options);
  const assignments = await loadAssignments(supabase, clients.map((client) => client.id));
  const allUploadIds = Array.from(new Set(assignments
    .filter((assignment) => assignment.upload_batches && !assignment.upload_batches.archived_at && assignment.upload_batches.status !== "archived")
    .map((assignment) => assignment.upload_batch_id)));
  const input = allUploadIds.length
    ? await loadStockNeedsInput(supabase, {
        uploadIds: allUploadIds,
        maxUploads: Math.min(Math.max(allUploadIds.length, 1), 50),
        recordsPerUploadLimit: 5000
      })
    : { records: [], profiles: [], importJobs: [], uploadIds: [] };
  const capabilities = clientCapabilities(role);

  return Promise.all(clients.map(async (client) => {
    const clientAssignments = assignmentsForClient(assignments, client.id);
    const uploadIds = new Set(clientAssignments.map((assignment) => assignment.upload_batch_id));
    const records = input.records.filter((record) => uploadIds.has(record.upload_batch_id));
    const profiles = input.profiles.filter((profile) => uploadIds.has(profile.upload_batch_id));
    const importJobs = input.importJobs.filter((job) => uploadIds.has(job.upload_batch_id));
    const opportunities = buildSalesOpportunitiesResult({
      records,
      profiles,
      importJobs,
      filters: { limit: 200 }
    });
    const mpns = new Set(records
      .map((record) => normalizePartNumberForMatch(record.mpn ?? record.mpn_quoted ?? null))
      .filter(Boolean));

    return {
      id: client.id,
      name: client.name,
      description: client.description,
      industry: client.industry,
      region: client.region,
      website: client.website,
      logoUrl: await signedAssetUrl(supabase, client.logo_path),
      status: client.status,
      fileCount: clientAssignments.length,
      mpnCount: mpns.size,
      ...opportunityMetrics(opportunities),
      createdAt: client.created_at,
      updatedAt: client.updated_at,
      canManage: capabilities.canManage
    };
  }));
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
      .select("identification_image_path,internal_notes")
      .eq("client_id", clientId)
      .maybeSingle();
    privateDetails = {
      identificationImageUrl: await signedAssetUrl(supabase, data?.identification_image_path ?? null),
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
