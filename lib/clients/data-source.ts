import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateSummaryStates,
  isSummaryContractUnavailable,
  loadBusinessSummaryState,
  type SummaryReadState
} from "@/lib/performance/summary-readiness";
import type { UserRole } from "@/lib/types";
import { deployedDemoCompanyLogoUrl } from "@/lib/clients/deployed-demo-company-logos";
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
const LOCAL_DEMO_COMPANY_IMAGE_PATTERN = /^\/?demo\/companies\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/;

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

export function resolveClientLogoUrl(clientId: string, logoPath: string | null) {
  if (!logoPath) return null;
  const deployedDemoLogoUrl = deployedDemoCompanyLogoUrl(clientId, logoPath);
  if (deployedDemoLogoUrl) return deployedDemoLogoUrl;
  if (LOCAL_DEMO_COMPANY_IMAGE_PATTERN.test(logoPath)) {
    return logoPath.startsWith("/") ? logoPath : `/${logoPath}`;
  }
  return `/api/clients/${encodeURIComponent(clientId)}/image?kind=logo`;
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

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function listClientSummaries(
  supabase: SupabaseClient,
  role: UserRole,
  options: ClientListOptions = {}
): Promise<AccountClient[]> {
  const clients = await loadClientRows(supabase, options);
  const capabilities = clientCapabilities(role);
  const clientIds = clients.map((client) => client.id);
  const [assignments, identificationImagePaths, lifecycle] = await Promise.all([
    loadAssignments(supabase, clientIds),
    loadAuthorizedIdentificationImagePaths(supabase, clientIds, capabilities.canViewPrivateIdentification),
    clientIds.length
      ? loadBusinessSummaryState(supabase, { clientId: options.clientId })
      : Promise.resolve<SummaryReadState>({
          status: "ready",
          currentVersion: null,
          requiredVersion: null,
          retryable: false,
          retryAfterSeconds: 0
        })
  ]);
  // The metrics RPC has a per-client post-read readiness fence. Run it even
  // when the broader visible-upload scope is rebuilding: an unrelated or
  // unassigned upload must not make every client card look stale.
  const metricsResult = clientIds.length
    ? await supabase.rpc("get_client_business_metrics_v1", { target_client_ids: clientIds })
    : { data: [], error: null };
  const metricsLifecycle: SummaryReadState = metricsResult.error
    ? {
        status: isSummaryContractUnavailable(metricsResult.error) ? "contract_unavailable" : "stale",
        currentVersion: lifecycle.currentVersion,
        requiredVersion: lifecycle.requiredVersion,
        retryable: !isSummaryContractUnavailable(metricsResult.error),
        retryAfterSeconds: isSummaryContractUnavailable(metricsResult.error) ? 60 : 3
      }
    : lifecycle;
  const metrics = new Map(((metricsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.client_id), row]));

  return clients.map((client) => {
    const clientAssignments = assignmentsForClient(assignments, client.id);
    const metric = metrics.get(client.id);
    const clientLifecycle: SummaryReadState = metricsResult.error
      ? metricsLifecycle
      : !metric
        ? {
          status: "contract_unavailable",
          currentVersion: metricsLifecycle.currentVersion,
          requiredVersion: metricsLifecycle.requiredVersion,
          retryable: false,
          retryAfterSeconds: 60
        }
        : metric.summary_ready === true
          ? {
              status: "ready",
              currentVersion: lifecycle.status === "ready" ? lifecycle.currentVersion : null,
              requiredVersion: lifecycle.status === "ready" ? lifecycle.requiredVersion : null,
              retryable: false,
              retryAfterSeconds: 0
            }
          : lifecycle.status !== "ready"
            ? lifecycle
            : {
                status: "stale",
                currentVersion: lifecycle.currentVersion,
                requiredVersion: lifecycle.requiredVersion,
                retryable: true,
                retryAfterSeconds: 3
              };
    const summaryReady = clientLifecycle.status === "ready";

    return {
      id: client.id,
      name: client.name,
      description: client.description,
      industry: client.industry,
      region: client.region,
      website: client.website,
      logoUrl: resolveClientLogoUrl(client.id, client.logo_path),
      authorizedIdentificationImageUrl: identificationImagePaths.get(client.id)
        ? `/api/clients/${client.id}/image?kind=identification`
        : null,
      status: client.status,
      fileCount: clientAssignments.length,
      summaryStatus: clientLifecycle.status,
      summaryCurrentVersion: clientLifecycle.currentVersion,
      summaryRequiredVersion: clientLifecycle.requiredVersion,
      mpnCount: summaryReady ? nullableNumber(metric?.mpn_count) : null,
      opportunityCount: summaryReady ? nullableNumber(metric?.opportunity_count) : null,
      immediateSaleCount: summaryReady ? nullableNumber(metric?.immediate_sale_count) : null,
      partialSaleCount: summaryReady ? nullableNumber(metric?.partial_sale_count) : null,
      sourcingNeededCount: summaryReady ? nullableNumber(metric?.sourcing_needed_count) : null,
      stockWithoutDemandCount: summaryReady ? nullableNumber(metric?.stock_without_demand_count) : null,
      highConfidenceCount: summaryReady ? nullableNumber(metric?.high_confidence_count) : null,
      highConfidenceTruncated: summaryReady && typeof metric?.high_confidence_truncated === "boolean"
        ? metric.high_confidence_truncated
        : null,
      createdAt: client.created_at,
      updatedAt: client.updated_at,
      canManage: capabilities.canManage
    };
  });
}

export function aggregateClientSummaryState(clients: AccountClient[]) {
  return aggregateSummaryStates(clients.map((client) => ({
    status: client.summaryStatus,
    currentVersion: client.summaryCurrentVersion,
    requiredVersion: client.summaryRequiredVersion,
    retryable: client.summaryStatus !== "ready" && client.summaryStatus !== "contract_unavailable",
    retryAfterSeconds: client.summaryStatus === "failed" ? 30 : client.summaryStatus === "contract_unavailable" ? 60 : 3
  })));
}

export async function clientExistsInScope(
  supabase: SupabaseClient,
  role: UserRole,
  clientId: string
) {
  const clients = await loadClientRows(supabase, {
    clientId,
    includeArchived: role !== "employee",
    limit: 1
  });
  return clients.length === 1;
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
