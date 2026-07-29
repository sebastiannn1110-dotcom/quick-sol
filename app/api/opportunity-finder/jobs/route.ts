import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import {
  opportunityFinderMaxFileSizeBytes,
  safeOpportunityFileName,
  safeOpportunityStoragePath,
  validateOpportunityFileMetadata
} from "@/lib/opportunity-finder/validation";
import {
  buildOpportunityFinderIdempotencyKey,
  OPPORTUNITY_FINDER_PIPELINE_VERSION,
  opportunityFinderPipelineVersionFromKey
} from "@/lib/opportunity-finder/pipeline";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fileSchema = z.object({
  side: z.enum(["A", "B"]),
  fileName: z.string().trim().min(1).max(260),
  fileSize: z.number().int().positive(),
  fileType: z.string().trim().max(180).optional().nullable()
});

const createSchema = z.object({
  files: z.array(fileSchema).length(2),
  idempotencyKey: z.string().trim().min(1).max(240).optional().nullable()
}).superRefine((value, context) => {
  if (new Set(value.files.map((file) => file.side)).size !== 2) {
    context.addIssue({
      code: "custom",
      message: "Exactly one file is required for each side."
    });
  }
});

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
    return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
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

  const idempotencyKey = parsed.data.idempotencyKey
    ? await buildOpportunityFinderIdempotencyKey({
      attemptId: parsed.data.idempotencyKey,
      files: parsed.data.files
    })
    : null;

  if (idempotencyKey) {
    const { data: existing } = await context.supabase
      .from("opportunity_finder_jobs")
      .select("id,status,created_at,idempotency_key")
      .eq("created_by", context.profile.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing) {
      return existingComparisonResponse(existing);
    }
  }

  const jobId = crypto.randomUUID();
  const files = parsed.data.files
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
        storagePath: safeOpportunityStoragePath({
          userId: context.profile.id,
          jobId,
          fileId: id,
          fileName: originalFileName
        })
      };
    });

  const { error: jobError } = await context.supabase
    .from("opportunity_finder_jobs")
    .insert({
      id: jobId,
      created_by: context.profile.id,
      idempotency_key: idempotencyKey,
      status: "uploading",
      current_stage: "uploading",
      progress_percent: 0
    });
  if (jobError) {
    if (idempotencyKey && jobError.code === "23505") {
      const { data: existing } = await context.supabase
        .from("opportunity_finder_jobs")
        .select("id,status,created_at,idempotency_key")
        .eq("created_by", context.profile.id)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing) return existingComparisonResponse(existing);
    }
    return NextResponse.json({ errorCode: "JOB_CREATE_FAILED" }, { status: 500 });
  }
  const { error: filesError } = await context.supabase
    .from("opportunity_finder_files")
    .insert(files.map((file) => ({
      id: file.id,
      job_id: jobId,
      side: file.side,
      original_file_name: file.originalFileName,
      storage_bucket: "opportunity-finder",
      storage_path: file.storagePath,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes,
      parse_status: "pending_upload"
    })));
  if (filesError) {
    await context.supabase.from("opportunity_finder_jobs").delete().eq("id", jobId).eq("created_by", context.profile.id);
    return NextResponse.json({ errorCode: "JOB_CREATE_FAILED" }, { status: 500 });
  }
  const { error: linkError } = await context.supabase
    .from("opportunity_finder_jobs")
    .update({ file_a_id: files[0].id, file_b_id: files[1].id })
    .eq("id", jobId)
    .eq("created_by", context.profile.id);
  if (linkError) {
    await context.supabase.from("opportunity_finder_jobs").delete().eq("id", jobId).eq("created_by", context.profile.id);
    return NextResponse.json({ errorCode: "JOB_CREATE_FAILED" }, { status: 500 });
  }

  const signedFiles = [];
  for (const file of files) {
    const { data, error } = await service.storage
      .from("opportunity-finder")
      .createSignedUploadUrl(file.storagePath);
    if (error || !data) {
      await context.supabase.from("opportunity_finder_jobs").update({
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
    action: "two_file_job_created",
    message: "Two-file Opportunity Finder job created.",
    status: "completed",
    metadata: {
      jobId,
      fileCount: 2,
      totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      maxFileSizeBytes: opportunityFinderMaxFileSizeBytes(),
      pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION
    }
  });
  return NextResponse.json({
    jobId,
    files: signedFiles,
    reusedExistingJob: false,
    pipelineVersion: OPPORTUNITY_FINDER_PIPELINE_VERSION
  }, { status: 201 });
}
