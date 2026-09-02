import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import {
  opportunityFinderMaxFileSizeBytes,
  OPPORTUNITY_FINDER_STORAGE_BUCKET,
  safeOpportunityFileName,
  safeOpportunityStoragePath,
  validateOpportunityFileMetadata
} from "@/lib/opportunity-finder/validation";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_CONTENT_SHA256_PATTERN,
  OPPORTUNITY_FINDER_PIPELINE_VERSION,
  opportunityFinderPipelineVersionFromKey
} from "@/lib/opportunity-finder/pipeline";
import { safeContextText } from "@/lib/opportunity-finder/normalization";
import { datasetScopeForRole } from "@/lib/opportunity-finder/single-file";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fileSchema = z.object({
  side: z.enum(["A", "B"]),
  fileName: z.string().trim().min(1).max(260),
  fileSize: z.number().int().positive(),
  fileType: z.string().trim().max(180).optional().nullable(),
  contentSha256: z.string().regex(OPPORTUNITY_FINDER_CONTENT_SHA256_PATTERN)
});

const createSchema = z.object({
  comparisonMode: z.enum(["single_file", "two_files"]).default("two_files"),
  files: z.array(fileSchema).min(1).max(2),
  clientContext: z.string().trim().max(160).optional().nullable()
}).superRefine((value, context) => {
  const expectedCount = value.comparisonMode === "single_file" ? 1 : 2;
  const sides = new Set(value.files.map((file) => file.side));
  if (
    value.files.length !== expectedCount
    || sides.size !== expectedCount
    || (value.comparisonMode === "single_file" && !sides.has("A"))
  ) {
    context.addIssue({
      code: "custom",
      message: value.comparisonMode === "single_file"
        ? "Exactly one side-A file is required."
        : "Exactly one file is required for each side."
    });
  }
});

const OPPORTUNITY_FINDER_MIGRATION_ERROR_CODES = new Set([
  "42P01",
  "42703",
  "42883",
  "PGRST202",
  "PGRST204",
  "PGRST205"
]);

function databaseFailureResponse(error: unknown) {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  const migrationRequired = OPPORTUNITY_FINDER_MIGRATION_ERROR_CODES.has(code)
    || /could not find|does not exist|schema cache|undefined (column|table|function)/i.test(message);

  return NextResponse.json({
    errorCode: migrationRequired
      ? "OPPORTUNITY_FINDER_MIGRATION_REQUIRED"
      : "JOB_CREATE_FAILED"
  }, { status: migrationRequired ? 503 : 500 });
}

function existingComparisonResponse(existing: {
  id: string;
  status: string;
  created_at?: string | null;
  idempotency_key?: string | null;
}) {
  return NextResponse.json({
    code: "COMPARISON_ALREADY_EXISTS",
    errorCode: "COMPARISON_ALREADY_EXISTS",
    jobId: existing.id,
    status: existing.status,
    reusedExistingJob: true,
    createdAt: existing.created_at ?? null,
    pipelineVersion: opportunityFinderPipelineVersionFromKey(existing.idempotency_key)
  }, { status: 409 });
}

function recordValue(value: unknown) {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped as Record<string, unknown>
    : null;
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const rate = checkRateLimit({
    key: `opportunity-finder:create:${context.profile.id}`,
    limit: 12,
    windowMs: 15 * 60 * 1000
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const invalidHash = parsed.error.issues.some((issue) =>
      issue.path.at(-1) === "contentSha256"
    );
    return NextResponse.json({
      errorCode: invalidHash ? "FILE_HASH_INVALID" : "FILES_REQUIRED_FOR_COMPARISON_MODE"
    }, { status: 400 });
  }
  for (const file of parsed.data.files) {
    const errorCode = validateOpportunityFileMetadata(file);
    if (errorCode) return NextResponse.json({ errorCode }, { status: errorCode === "FILE_TOO_LARGE" ? 413 : 400 });
  }
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });

  const clientContext = safeContextText(parsed.data.clientContext, 160);
  const comparisonMode = parsed.data.comparisonMode;
  let datasetManifest: Record<string, unknown> | [] = [];
  let datasetVersion: string | null = null;
  const datasetScope = comparisonMode === "single_file"
    ? datasetScopeForRole(context.profile.role)
    : null;
  if (comparisonMode === "single_file") {
    const locatorResult = await context.supabase.rpc("get_opportunity_finder_dataset_locator_v2");
    if (locatorResult.error) {
      if (/OPPORTUNITY_DATASET_SUMMARY_NOT_READY/.test(locatorResult.error.message ?? "")) {
        return NextResponse.json({ errorCode: "DATASET_SUMMARY_NOT_READY" }, {
          status: 409,
          headers: { "Cache-Control": "private, no-store, max-age=0", "Retry-After": "5" }
        });
      }
      return databaseFailureResponse(locatorResult.error);
    }
    const locator = recordValue(locatorResult.data);
    const manifest = recordValue(locator?.datasetManifest);
    const locatorVersion = locator?.datasetVersion;
    const locatorScope = locator?.datasetScope;
    if (
      typeof locatorVersion !== "string"
      || !/^[0-9a-f]{64}$/.test(locatorVersion)
      || locatorScope !== datasetScope
      || manifest?.kind !== "opportunity-dataset-locator-v2"
      || typeof manifest.universeVersion !== "string"
      || typeof manifest.authorizationHash !== "string"
      || !/^[0-9a-f]{64}$/.test(manifest.authorizationHash)
      || !Number.isSafeInteger(Number(manifest.uploadCount))
      || Number(manifest.uploadCount) < 0
    ) {
      return NextResponse.json({ errorCode: "OPPORTUNITY_FINDER_DATASET_LOCATOR_INVALID" }, { status: 503 });
    }
    datasetManifest = manifest;
    datasetVersion = locatorVersion;
  }
  const idempotencyKey = comparisonMode === "two_files"
    ? await buildOpportunityFinderIdempotencyKey({
      files: parsed.data.files,
      clientContext,
      comparisonMode
    })
    : null;

  if (idempotencyKey) {
    const { data: existing, error: existingError } = await context.supabase
      .from("opportunity_finder_jobs")
      .select("id,status,created_at,idempotency_key")
      .eq("tenant_id", context.profile.id)
      .eq("created_by", context.profile.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) return databaseFailureResponse(existingError);
    if (existing) return existingComparisonResponse(existing);
  }

  const jobId = crypto.randomUUID();
  const uploadedFiles = parsed.data.files
    .sort((left, right) => left.side.localeCompare(right.side))
    .map((file) => {
      const id = crypto.randomUUID();
      const originalFileName = safeOpportunityFileName(file.fileName);
      return {
        id,
        side: file.side,
        originalFileName,
        mimeType: file.fileType || null,
        sizeBytes: file.fileSize,
        contentSha256: file.contentSha256,
        storagePath: safeOpportunityStoragePath({
          userId: context.profile.id,
          jobId,
          fileId: id,
          fileName: originalFileName
        })
      };
    });
  const virtualFileId = comparisonMode === "single_file" ? crypto.randomUUID() : null;
  const files = comparisonMode === "single_file"
    ? [...uploadedFiles, {
      id: virtualFileId!,
      side: "B" as const,
      originalFileName: "Base autorizada de Electronic Parts",
      mimeType: "application/json",
      sizeBytes: 1,
      contentSha256: datasetVersion!,
      storagePath: safeOpportunityStoragePath({
        userId: context.profile.id,
        jobId,
        fileId: virtualFileId!,
        fileName: "platform-snapshot.json"
      })
    }]
    : uploadedFiles;

  const { error: jobError } = await service
    .from("opportunity_finder_jobs")
    .insert({
      id: jobId,
      created_by: context.profile.id,
      tenant_id: context.profile.id,
      client_context: clientContext,
      pipeline_version: OPPORTUNITY_FINDER_PIPELINE_VERSION,
      idempotency_key: idempotencyKey,
      comparison_mode: comparisonMode,
      dataset_version: datasetVersion,
      dataset_scope: datasetScope,
      dataset_manifest: datasetManifest,
      snapshot_status: comparisonMode === "single_file" ? "pending" : "not_required",
      status: "uploading",
      current_stage: "uploading",
      progress_percent: 0
    });
  if (jobError) {
    if (jobError.code === "23505") {
      const { data: existing } = await context.supabase
        .from("opportunity_finder_jobs")
        .select("id,status,created_at,idempotency_key")
        .eq("tenant_id", context.profile.id)
        .eq("created_by", context.profile.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing) return existingComparisonResponse(existing);
    }
    return databaseFailureResponse(jobError);
  }
  const { error: filesError } = await service
    .from("opportunity_finder_files")
    .insert(files.map((file) => ({
      id: file.id,
      job_id: jobId,
      side: file.side,
      original_file_name: file.originalFileName,
      storage_bucket: OPPORTUNITY_FINDER_STORAGE_BUCKET,
      storage_path: file.storagePath,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      content_sha256: file.contentSha256,
      validation_status: file.id === virtualFileId ? "verified" : "pending",
      parse_status: file.id === virtualFileId ? "profiled" : "pending_upload",
      source_kind: file.id === virtualFileId ? "platform_snapshot" : "uploaded",
      detected_type: "unknown"
    })));
  if (filesError) {
    await service.from("opportunity_finder_jobs").delete().eq("id", jobId).eq("created_by", context.profile.id);
    return databaseFailureResponse(filesError);
  }
  const { error: linkError } = await service
    .from("opportunity_finder_jobs")
    .update({ file_a_id: files[0].id, file_b_id: files[1].id })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (linkError) {
    await service.from("opportunity_finder_jobs").delete().eq("id", jobId).eq("created_by", context.profile.id);
    return databaseFailureResponse(linkError);
  }

  const signedFiles = [];
  for (const file of uploadedFiles) {
    const { data, error } = await service.storage
      .from(OPPORTUNITY_FINDER_STORAGE_BUCKET)
      .createSignedUploadUrl(file.storagePath);
    if (error || !data) {
      await service.from("opportunity_finder_jobs").update({
        status: "failed",
        error_code: "SIGNED_UPLOAD_CREATE_FAILED"
      }).eq("id", jobId).eq("created_by", context.profile.id);
      return NextResponse.json({ errorCode: "SIGNED_UPLOAD_CREATE_FAILED" }, { status: 500 });
    }
    signedFiles.push({
      id: file.id,
      side: file.side,
      originalFileName: file.originalFileName,
      sizeBytes: file.sizeBytes,
      signedUrl: data.signedUrl,
      token: data.token,
      path: data.path
    });
  }

  await logger.info({
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    module: "opportunity-finder",
    action: comparisonMode === "single_file" ? "single_file_job_created" : "two_file_job_created",
    message: comparisonMode === "single_file"
      ? "Single-file Opportunity Finder job created."
      : "Two-file Opportunity Finder job created.",
    status: "completed",
    metadata: {
      jobId,
      fileCount: uploadedFiles.length,
      totalSizeBytes: uploadedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      maxFileSizeBytes: opportunityFinderMaxFileSizeBytes(),
      pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
      comparisonMode
    }
  });
  await logAuditEvent(context, "opportunity_finder_job_created", "opportunity_finder_job", jobId, {
    fileCount: uploadedFiles.length,
    totalSizeBytes: uploadedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION,
    comparisonMode
  });
  return NextResponse.json({
    jobId,
    files: signedFiles,
    comparisonMode,
    reusedExistingJob: false,
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION
  }, { status: 201 });
}
