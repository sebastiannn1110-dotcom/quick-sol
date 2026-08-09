import { NextResponse } from "next/server";
import path from "node:path";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { cleanUuid, loadOwnedOpportunityJob } from "@/lib/opportunity-finder/api";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { assertCanonicalOpportunityStorageReference } from "@/lib/opportunity-finder/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  }
  const jobId = cleanUuid((await params).id);
  if (!jobId) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const job = await loadOwnedOpportunityJob(context.supabase, jobId, context.profile.id);
  if (!job) return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
  const jobStatus = String(job.status ?? "");
  if (!["uploading", "failed"].includes(jobStatus)) {
    return NextResponse.json({ jobId, status: jobStatus });
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ errorCode: "STORAGE_NOT_CONFIGURED" }, { status: 503 });
  const { data: expectedFiles, error: expectedError } = await context.supabase
    .from("opportunity_finder_files")
    .select("id,job_id,original_file_name,storage_bucket,storage_path,size_bytes")
    .eq("job_id", jobId);
  if (expectedError || expectedFiles?.length !== 2) {
    return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
  }
  try {
    for (const file of expectedFiles) {
      assertCanonicalOpportunityStorageReference({
        ownerId: context.profile.id,
        jobId,
        fileId: file.id,
        originalFileName: file.original_file_name,
        storageBucket: file.storage_bucket,
        storagePath: file.storage_path
      });
    }
  } catch {
    return NextResponse.json({ errorCode: "FILE_STORAGE_REFERENCE_INVALID" }, { status: 500 });
  }
  for (const file of expectedFiles) {
    const folder = path.posix.dirname(file.storage_path);
    const name = path.posix.basename(file.storage_path);
    const { data: objects, error: listError } = await service.storage
      .from(file.storage_bucket)
      .list(folder, { search: name, limit: 2 });
    const object = objects?.find((item) => item.name === name);
    if (listError || !object) {
      return NextResponse.json({ errorCode: "UPLOAD_INCOMPLETE" }, { status: 409 });
    }
    const uploadedSize = Number(object.metadata?.size ?? 0);
    if (uploadedSize > 0 && uploadedSize !== Number(file.size_bytes)) {
      await service
        .from("opportunity_finder_files")
        .update({ validation_status: "size_mismatch", actual_size_bytes: uploadedSize })
        .eq("id", file.id)
        .eq("job_id", jobId);
      return NextResponse.json({ errorCode: "FILE_SIZE_MISMATCH" }, { status: 400 });
    }
  }
  const uploadedAt = new Date().toISOString();
  const { data: queuedJob, error } = await service.rpc("queue_opportunity_finder_profile", {
    job_id: jobId,
    actor_id: context.profile.id,
    expected_status: jobStatus,
    uploaded_at: uploadedAt
  });
  if (error) {
    if (error.code === "P0002") {
      return NextResponse.json({ errorCode: "JOB_NOT_FOUND" }, { status: 404 });
    }
    if (error.code === "55000" || error.code === "40001") {
      return NextResponse.json({ errorCode: "JOB_QUEUE_CONFLICT" }, { status: 409 });
    }
    if (error.code === "22023") {
      return NextResponse.json({ errorCode: "EXACTLY_TWO_FILES_REQUIRED" }, { status: 400 });
    }
    return NextResponse.json({ errorCode: "JOB_QUEUE_FAILED" }, { status: 500 });
  }
  const committedJob = (Array.isArray(queuedJob) ? queuedJob[0] : queuedJob) as
    | Record<string, unknown>
    | null;
  if (committedJob?.status !== "queued") {
    return NextResponse.json({ errorCode: "JOB_QUEUE_CONFLICT" }, { status: 409 });
  }
  await logAuditEvent(context, "opportunity_finder_upload_confirmed", "opportunity_finder_job", jobId, {
    fileCount: 2
  });
  return NextResponse.json({ jobId, status: "queued", currentStage: "inspecting_sheets" });
}
