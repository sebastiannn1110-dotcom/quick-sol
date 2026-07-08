import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { SECURITY_LIMITS } from "@/lib/security/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ImportJobStatus = "queued" | "retrying" | "processing" | "completed" | "failed" | "cancelled" | "pending_upload" | "uploaded";

function elapsedSeconds(date: string | null | undefined) {
  if (!date) return null;
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const logContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: "GET",
    module: "upload" as const,
    action: "job_status_polled",
    message: "Import job status polled.",
    status: "started" as const,
    metadata: { jobId: id }
  };

  await logger.debug(logContext);

  if (context.isDemoMode || !context.supabase) {
    await logger.warn({
      ...logContext,
      action: "job_status_auth_denied",
      message: "Supabase is required for import jobs.",
      status: "failed"
    });
    return NextResponse.json({ error: "Supabase is required for import jobs." }, { status: 503 });
  }

  const { data: job, error } = await context.supabase
    .from("import_jobs")
    .select("*, upload_batches(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    await logger.error({
      ...logContext,
      action: "job_status_failed",
      message: "Unable to load import job.",
      status: "failed",
      error
    });
    return NextResponse.json({ error: "Unable to load import job." }, { status: 500 });
  }
  if (!job) {
    await logger.warn({
      ...logContext,
      action: "job_status_not_found",
      message: "Import job not found.",
      status: "failed"
    });
    return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  }

  const status = job.status as ImportJobStatus;
  const queuedStatuses: ImportJobStatus[] = ["queued", "retrying"];
  const queueState = {
    position: null as number | null,
    queuedCount: null as number | null,
    currentProcessingJob: null as null | {
      jobId: string;
      uploadBatchId: string;
      fileName: string;
      workerId: string | null;
      heartbeatAt: string | null;
      processingStartedAt: string | null;
    },
    workerConcurrency: SECURITY_LIMITS.workerConcurrency,
    queuedForSeconds: elapsedSeconds(job.upload_batches?.queued_at ?? null),
    processingForSeconds: elapsedSeconds(job.started_at ?? job.upload_batches?.processing_started_at ?? null),
    lastHeartbeatAt: job.heartbeat_at ?? job.upload_batches?.worker_last_heartbeat_at ?? null
  };

  const { data: processingJobs } = await context.supabase
    .from("import_jobs")
    .select("id,upload_batch_id,original_file_name,worker_id,heartbeat_at,started_at")
    .eq("status", "processing")
    .order("started_at", { ascending: true })
    .limit(Math.max(SECURITY_LIMITS.workerConcurrency, 1));

  const currentProcessing = processingJobs?.[0];
  if (currentProcessing) {
    queueState.currentProcessingJob = {
      jobId: currentProcessing.id,
      uploadBatchId: currentProcessing.upload_batch_id,
      fileName: currentProcessing.original_file_name,
      workerId: currentProcessing.worker_id ?? null,
      heartbeatAt: currentProcessing.heartbeat_at ?? null,
      processingStartedAt: currentProcessing.started_at ?? null
    };
  }

  if (queuedStatuses.includes(status)) {
    const { data: queuedJobs } = await context.supabase
      .from("import_jobs")
      .select("id")
      .in("status", queuedStatuses)
      .order("next_retry_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(500);
    const ids = queuedJobs?.map((queuedJob) => queuedJob.id) ?? [];
    const index = ids.indexOf(job.id);
    queueState.position = index >= 0 ? index + 1 : null;
    queueState.queuedCount = ids.length;
  }

  const queuedTooLong = status === "queued" && (queueState.queuedForSeconds ?? 0) > 5 * 60;
  const heartbeatTooOld = status === "processing" && queueState.lastHeartbeatAt
    ? elapsedSeconds(queueState.lastHeartbeatAt)! > SECURITY_LIMITS.workerStaleAfterMinutes * 60
    : false;

  if (queuedTooLong || heartbeatTooOld) {
    await logger.warn({
      ...logContext,
      action: queuedTooLong ? "job_queued_slow_warning" : "job_heartbeat_stale_warning",
      message: queuedTooLong
        ? "Import job has been queued longer than expected."
        : "Processing import job heartbeat is older than expected.",
      status: "completed",
      uploadBatchId: job.upload_batch_id,
      fileName: job.original_file_name,
      metadata: {
        jobId: job.id,
        currentStatus: status,
        queuedForSeconds: queueState.queuedForSeconds,
        lastHeartbeatAt: queueState.lastHeartbeatAt,
        workerConcurrency: queueState.workerConcurrency
      }
    });
  }

  await logger.debug({
    ...logContext,
    action: "job_status_returned",
    message: "Import job status returned.",
    status: "completed",
    uploadBatchId: job.upload_batch_id,
    fileName: job.original_file_name,
    metadata: {
      jobId: job.id,
      currentStatus: status,
      queuePosition: queueState.position,
      queuedCount: queueState.queuedCount,
      workerId: job.worker_id ?? null,
      heartbeatAt: queueState.lastHeartbeatAt
    }
  });

  return NextResponse.json({ job, upload: job.upload_batches, queue: queueState });
}
