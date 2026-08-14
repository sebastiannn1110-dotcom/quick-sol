import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob, roleValue } from "@/lib/opportunity-finder/api";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";
import {
  buildPlatformSnapshotRows,
  datasetVersionFromManifest,
  loadAuthorizedPlatformCandidates,
  type OpportunityDatasetManifestEntry
} from "@/lib/opportunity-finder/single-file";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function manifestValue(value: unknown): OpportunityDatasetManifestEntry[] | null {
  if (!Array.isArray(value)) return null;
  const rows: OpportunityDatasetManifestEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (
      typeof row.uploadBatchId !== "string"
      || typeof row.ownerId !== "string"
      || !Number.isSafeInteger(Number(row.dataVersion))
      || Number(row.dataVersion) <= 0
    ) return null;
    rows.push({
      uploadBatchId: row.uploadBatchId,
      ownerId: row.ownerId,
      dataVersion: Number(row.dataVersion)
    });
  }
  return rows;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  if (
    job.comparison_mode !== "single_file"
    || job.snapshot_status !== "pending"
    || job.status !== "awaiting_roles"
  ) {
    return NextResponse.json({ errorCode: "DATASET_SNAPSHOT_NOT_READY" }, { status: 409 });
  }
  const uploadedRole = roleValue(job.uploaded_role);
  const manifest = manifestValue(job.dataset_manifest);
  const datasetVersion = typeof job.dataset_version === "string" ? job.dataset_version : null;
  const datasetScope = typeof job.dataset_scope === "string" ? job.dataset_scope : null;
  if (
    !uploadedRole || uploadedRole === "ignore" || !manifest || !datasetVersion || !datasetScope
    || datasetVersionFromManifest(manifest) !== datasetVersion
  ) {
    return NextResponse.json({ errorCode: "DATASET_SNAPSHOT_INVALID" }, { status: 409 });
  }

  const lookupStartedAt = performance.now();
  const { data: mpnRows, error: mpnError } = await context.supabase.rpc(
    "get_opportunity_finder_uploaded_mpns",
    { job_id: jobId }
  );
  if (mpnError) return NextResponse.json({ errorCode: "DATASET_LOOKUP_FAILED" }, { status: 500 });
  const normalizedMpns = (mpnRows ?? [])
    .map((row: { normalized_mpn?: unknown }) => String(row.normalized_mpn ?? ""))
    .filter(Boolean);
  let candidates;
  try {
    candidates = await loadAuthorizedPlatformCandidates({
      supabase: context.supabase,
      manifest,
      normalizedMpns
    });
  } catch {
    return NextResponse.json({ errorCode: "DATASET_LOOKUP_FAILED" }, { status: 500 });
  }
  const snapshotRows = buildPlatformSnapshotRows({ uploadedRole, candidates });
  const lookupDurationMs = Math.round((performance.now() - lookupStartedAt) * 10) / 10;

  const { data: files, error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .select("id,side,content_sha256,source_kind")
    .eq("job_id", jobId);
  const uploadedFile = files?.find((file) => file.source_kind === "uploaded");
  if (filesError || !uploadedFile?.content_sha256) {
    return NextResponse.json({ errorCode: "FILE_HASH_NOT_VERIFIED" }, { status: 409 });
  }
  const idempotencyKey = await buildOpportunityFinderIdempotencyKey({
    files: [{ side: "A", contentSha256: uploadedFile.content_sha256 }],
    pipelineVersion: typeof job.pipeline_version === "string"
      ? job.pipeline_version
      : OPPORTUNITY_FINDER_PIPELINE_VERSION,
    clientContext: typeof job.client_context === "string" ? job.client_context : null,
    comparisonMode: "single_file",
    uploadedRole,
    datasetVersion,
    tenantScope: `${job.tenant_id}:${datasetScope}:${context.profile.id}`
  });
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
  const snapshotId = crypto.randomUUID();
  const { data, error } = await service.rpc("persist_opportunity_finder_dataset_snapshot", {
    job_id: jobId,
    actor_id: context.profile.id,
    snapshot_id: snapshotId,
    dataset_version: datasetVersion,
    dataset_scope: datasetScope,
    manifest,
    rows: snapshotRows,
    idempotency_key: idempotencyKey,
    lookup_metrics: {
      candidateLookupMs: lookupDurationMs,
      candidateCount: snapshotRows.length,
      candidateMpnCount: new Set(snapshotRows.map((row) => row.normalized_mpn)).size
    }
  });
  if (error) {
    if (error.code === "40001") {
      return NextResponse.json({ errorCode: "DATASET_SNAPSHOT_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ errorCode: "DATASET_SNAPSHOT_FAILED" }, { status: 500 });
  }
  const committed = (Array.isArray(data) ? data[0] : data) as { committed_job_id?: string; reused?: boolean } | null;
  if (committed?.reused) {
    return NextResponse.json({
      code: "COMPARISON_ALREADY_EXISTS",
      errorCode: "COMPARISON_ALREADY_EXISTS",
      jobId: committed.committed_job_id,
      reusedExistingJob: true
    }, { status: 409 });
  }
  return NextResponse.json({
    jobId,
    status: "queued",
    snapshotStatus: "ready",
    datasetVersion,
    existingEntityCount: snapshotRows.length,
    existingMpnCount: new Set(snapshotRows.map((row) => row.normalized_mpn)).size
  });
}
