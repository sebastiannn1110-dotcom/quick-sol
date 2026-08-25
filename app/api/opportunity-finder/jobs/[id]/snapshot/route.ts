import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob, roleValue } from "@/lib/opportunity-finder/api";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION
} from "@/lib/opportunity-finder/pipeline";
import {
  OPPORTUNITY_SNAPSHOT_MAX_CHUNK_BYTES,
  OPPORTUNITY_SNAPSHOT_MAX_CHUNK_ROWS
} from "@/lib/opportunity-finder/single-file";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SNAPSHOT_REQUEST_MAX_CHUNKS = 4;
const SNAPSHOT_REQUEST_TIME_BUDGET_MS = 1_500;
const SNAPSHOT_READ_MAX_ROWS = Math.min(OPPORTUNITY_SNAPSHOT_MAX_CHUNK_ROWS, 250);
const SNAPSHOT_READ_MAX_BYTES = Math.min(OPPORTUNITY_SNAPSHOT_MAX_CHUNK_BYTES, 2 * 1024 * 1024);
const SNAPSHOT_RETRY_AFTER_SECONDS = 2;

function snapshotJson(body: unknown, status = 200) {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store, max-age=0" };
  if (status === 202) headers["Retry-After"] = String(SNAPSHOT_RETRY_AFTER_SECONDS);
  return NextResponse.json(body, {
    status,
    headers
  });
}

type RpcError = { code?: string | null } | null;

function rpcRecord(value: unknown) {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped as Record<string, unknown>
    : null;
}

function requiredString(row: Record<string, unknown> | null, key: string) {
  const value = row?.[key];
  return typeof value === "string" && value ? value : null;
}

function requiredInteger(row: Record<string, unknown> | null, key: string) {
  const value = Number(row?.[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function snapshotConflict(error: RpcError) {
  return error?.code === "40001" || error?.code === "23505" || error?.code === "55000";
}

function appendRetryable(error: RpcError) {
  return Boolean(error?.code && ["40001", "53300", "57014", "57P01"].includes(error.code));
}

async function appendSnapshotChunk(
  service: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  args: Record<string, unknown>
) {
  const first = await service.rpc("append_opportunity_finder_dataset_snapshot_rows_v2", args);
  if (!first.error || !appendRetryable(first.error)) return first;
  return service.rpc("append_opportunity_finder_dataset_snapshot_rows_v2", args);
}

type SnapshotCursor = {
  candidateSourceRecordId: string | null;
  candidateEntityKind: string | null;
  done: boolean;
};

function cursorValue(value: unknown, allowEmpty = false): SnapshotCursor | null {
  const row = rpcRecord(value);
  if (!row) return allowEmpty ? { candidateSourceRecordId: null, candidateEntityKind: null, done: false } : null;
  const sourceRecordId = row.candidateSourceRecordId;
  const entityKind = row.candidateEntityKind;
  if ((sourceRecordId === null || sourceRecordId === undefined)
      !== (entityKind === null || entityKind === undefined)) return null;
  if (sourceRecordId !== null && sourceRecordId !== undefined && typeof sourceRecordId !== "string") return null;
  if (entityKind !== null && entityKind !== undefined && typeof entityKind !== "string") return null;
  if (typeof row.done !== "boolean") return allowEmpty && Object.keys(row).length === 0
    ? { candidateSourceRecordId: null, candidateEntityKind: null, done: false }
    : null;
  return {
    candidateSourceRecordId: typeof sourceRecordId === "string" ? sourceRecordId : null,
    candidateEntityKind: typeof entityKind === "string" ? entityKind : null,
    done: row.done
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) {
    context.headers.set("Cache-Control", "private, no-store, max-age=0");
    return context;
  }
  if (context.isDemoMode || !context.supabase) {
    return snapshotJson({ errorCode: "DATABASE_NOT_CONFIGURED" }, 503);
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return snapshotJson({ errorCode: "JOB_NOT_FOUND" }, 404);
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return snapshotJson({ errorCode: "JOB_NOT_FOUND" }, 404);
  if (
    job.comparison_mode !== "single_file"
    || job.snapshot_status !== "pending"
    || job.status !== "awaiting_roles"
  ) {
    return snapshotJson({ errorCode: "DATASET_SNAPSHOT_NOT_READY" }, 409);
  }
  const uploadedRole = roleValue(job.uploaded_role);
  const manifest = rpcRecord(job.dataset_manifest);
  const datasetVersion = typeof job.dataset_version === "string" ? job.dataset_version : null;
  const datasetScope = typeof job.dataset_scope === "string" ? job.dataset_scope : null;
  if (
    !uploadedRole || uploadedRole === "ignore" || !manifest || !datasetVersion || !datasetScope
    || manifest.kind !== "opportunity-dataset-locator-v2"
    || typeof manifest.universeVersion !== "string"
    || typeof manifest.authorizationHash !== "string"
  ) {
    return snapshotJson({ errorCode: "DATASET_SNAPSHOT_INVALID" }, 409);
  }

  const { data: files, error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .select("id,side,content_sha256,source_kind")
    .eq("job_id", jobId);
  const uploadedFile = files?.find((file) => file.source_kind === "uploaded");
  if (filesError || !uploadedFile?.content_sha256) {
    return snapshotJson({ errorCode: "FILE_HASH_NOT_VERIFIED" }, 409);
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
  if (!service) return snapshotJson({ errorCode: "DATABASE_NOT_CONFIGURED" }, 503);
  const snapshotId = crypto.randomUUID();
  const begin = await service.rpc("begin_opportunity_finder_dataset_snapshot_v2", {
    input_job_id: jobId,
    input_actor_id: context.profile.id,
    input_snapshot_id: snapshotId,
    input_dataset_version: datasetVersion,
    input_dataset_scope: datasetScope,
    input_idempotency_key: idempotencyKey,
    input_lookup_metrics: {
      strategy: "bounded_sql_page_v2",
      chunkRowsMax: SNAPSHOT_READ_MAX_ROWS,
      chunkBytesMax: SNAPSHOT_READ_MAX_BYTES,
      requestChunksMax: SNAPSHOT_REQUEST_MAX_CHUNKS,
      requestTimeBudgetMs: SNAPSHOT_REQUEST_TIME_BUDGET_MS
    }
  });
  if (begin.error) {
    if (snapshotConflict(begin.error)) {
      return snapshotJson({ errorCode: "DATASET_SNAPSHOT_CONFLICT" }, 409);
    }
    return snapshotJson({ errorCode: "DATASET_SNAPSHOT_FAILED" }, 500);
  }
  const begun = rpcRecord(begin.data);
  if (begun?.reused === true) {
    return snapshotJson({
      code: "COMPARISON_ALREADY_EXISTS",
      errorCode: "COMPARISON_ALREADY_EXISTS",
      jobId: requiredString(begun, "committedJobId"),
      reusedExistingJob: true
    }, 409);
  }

  const committedSnapshotId = requiredString(begun, "snapshotId");
  const generation = requiredInteger(begun, "generation");
  const fenceToken = requiredInteger(begun, "fenceToken");
  let nextChunkSequence = requiredInteger(begun, "nextChunkSequence");
  let entityCount = requiredInteger(begun, "entityCount");
  let rowsFingerprint = requiredString(begun, "rowsFingerprint");
  let cursor = cursorValue(begun?.cursor, true);
  const resumed = begun?.resumed === true;
  if (
    begun?.reused !== false
    || !committedSnapshotId
    || (!resumed && committedSnapshotId !== snapshotId)
    || generation === null
    || fenceToken === null
    || nextChunkSequence === null
    || entityCount === null
    || !rowsFingerprint
    || !/^[0-9a-f]{64}$/.test(rowsFingerprint)
    || !cursor
  ) {
    return snapshotJson({ errorCode: "DATASET_SNAPSHOT_PROTOCOL_INVALID" }, 500);
  }

  const requestStartedAt = performance.now();
  let candidatePageCount = 0;
  let candidateRowCount = 0;
  let processedChunks = 0;

  while (!cursor.done && processedChunks < SNAPSHOT_REQUEST_MAX_CHUNKS) {
    if (processedChunks > 0 && performance.now() - requestStartedAt >= SNAPSHOT_REQUEST_TIME_BUDGET_MS) break;
    if (request.signal.aborted) {
      return snapshotJson({ errorCode: "DATASET_SNAPSHOT_REQUEST_ABORTED" }, 499);
    }
    const page = await service.rpc("read_opportunity_finder_snapshot_chunk_v2", {
      input_job_id: jobId,
      input_actor_id: context.profile.id,
      input_snapshot_id: committedSnapshotId,
      input_generation: generation,
      input_fence_token: fenceToken,
      input_after_source_record_id: cursor.candidateSourceRecordId,
      input_after_entity_kind: cursor.candidateEntityKind,
      input_limit: SNAPSHOT_READ_MAX_ROWS,
      input_max_bytes: SNAPSHOT_READ_MAX_BYTES
    });
    if (page.error) {
      return snapshotJson(
        { errorCode: snapshotConflict(page.error) ? "DATASET_SNAPSHOT_CONFLICT" : "DATASET_LOOKUP_FAILED" },
        snapshotConflict(page.error) ? 409 : 500
      );
    }
    const read = rpcRecord(page.data);
    const rows = Array.isArray(read?.rows) ? read.rows : null;
    const rowCount = requiredInteger(read, "rowCount");
    const scannedRows = requiredInteger(read, "scannedRows");
    const payloadBytes = requiredInteger(read, "payloadBytes");
    const chunkFingerprint = requiredString(read, "chunkFingerprint");
    const nextCursor = cursorValue(read?.nextCursor);
    if (
      !rows || rowCount === null || rowCount !== rows.length
      || scannedRows === null || scannedRows > SNAPSHOT_READ_MAX_ROWS
      || payloadBytes === null || payloadBytes > SNAPSHOT_READ_MAX_BYTES
      || !chunkFingerprint || !/^[0-9a-f]{64}$/.test(chunkFingerprint)
      || !nextCursor || read?.done !== nextCursor.done
    ) {
      return snapshotJson({ errorCode: "DATASET_SNAPSHOT_PROTOCOL_INVALID" }, 500);
    }

    const append = await appendSnapshotChunk(service, {
      input_job_id: jobId,
      input_actor_id: context.profile.id,
      input_snapshot_id: committedSnapshotId,
      input_generation: generation,
      input_fence_token: fenceToken,
      input_chunk_sequence: nextChunkSequence,
      input_rows: rows,
      input_payload_bytes: payloadBytes,
      input_chunk_fingerprint: chunkFingerprint,
      input_next_cursor: nextCursor
    });
    if (append.error) {
      return snapshotJson(
        { errorCode: snapshotConflict(append.error) ? "DATASET_SNAPSHOT_CONFLICT" : "DATASET_SNAPSHOT_FAILED" },
        snapshotConflict(append.error) ? 409 : 500
      );
    }
    const appended = rpcRecord(append.data);
    const appendedNextSequence = requiredInteger(appended, "nextChunkSequence");
    const appendedEntityCount = requiredInteger(appended, "entityCount");
    const appendedFingerprint = requiredString(appended, "rowsFingerprint");
    const appendedCursor = cursorValue(appended?.cursor);
    if (
      (appended?.accepted !== true && appended?.duplicate !== true)
      || appendedNextSequence !== nextChunkSequence + 1
      || appendedEntityCount === null
      || !appendedFingerprint
      || !/^[0-9a-f]{64}$/.test(appendedFingerprint)
      || !appendedCursor
      || JSON.stringify(appendedCursor) !== JSON.stringify(nextCursor)
    ) {
      return snapshotJson({ errorCode: "DATASET_SNAPSHOT_PROTOCOL_INVALID" }, 500);
    }
    nextChunkSequence = appendedNextSequence;
    entityCount = appendedEntityCount;
    rowsFingerprint = appendedFingerprint;
    cursor = appendedCursor;
    candidatePageCount += 1;
    candidateRowCount += scannedRows;
    processedChunks += 1;
  }

  if (!cursor.done) {
    return snapshotJson({
      jobId,
      status: "building",
      snapshotStatus: "pending",
      datasetVersion,
      processedChunks,
      existingEntityCount: entityCount
    }, 202);
  }

  const lookupDurationMs = Math.round((performance.now() - requestStartedAt) * 10) / 10;
  const finalized = await service.rpc("finalize_opportunity_finder_dataset_snapshot_v2", {
    input_job_id: jobId,
    input_actor_id: context.profile.id,
    input_snapshot_id: committedSnapshotId,
    input_generation: generation,
    input_fence_token: fenceToken,
    input_expected_entity_count: entityCount,
    input_rows_fingerprint: rowsFingerprint,
    input_lookup_metrics: {
      strategy: "bounded_sql_page_v2",
      candidateLookupMs: lookupDurationMs,
      candidatePageCount,
      candidateRowCount,
      chunkCount: nextChunkSequence
    }
  });
  if (finalized.error) {
    return snapshotJson(
      { errorCode: snapshotConflict(finalized.error) ? "DATASET_SNAPSHOT_CONFLICT" : "DATASET_SNAPSHOT_FAILED" },
      snapshotConflict(finalized.error) ? 409 : 500
    );
  }
  const committed = rpcRecord(finalized.data);
  const finalizedEntityCount = requiredInteger(committed, "entityCount");
  const finalizedMpnCount = requiredInteger(committed, "mpnCount");
  if (
    committed?.reused !== false
    || requiredString(committed, "committedJobId") !== jobId
    || requiredString(committed, "snapshotId") !== committedSnapshotId
    || committed?.status !== "ready"
    || finalizedEntityCount !== entityCount
    || finalizedMpnCount === null
  ) {
    return snapshotJson({ errorCode: "DATASET_SNAPSHOT_PROTOCOL_INVALID" }, 500);
  }
  return snapshotJson({
    jobId,
    status: "queued",
    snapshotStatus: "ready",
    datasetVersion,
    existingEntityCount: finalizedEntityCount,
    existingMpnCount: finalizedMpnCount
  });
}
