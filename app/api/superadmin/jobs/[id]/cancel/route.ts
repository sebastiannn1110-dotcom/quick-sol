import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const { data: job, error } = await context.service.rpc("request_import_job_cancel_v2", {
    input_actor_id: context.profile.id,
    input_job_id: id
  });
  if (error) {
    const mapped = importLifecycleError(error, "Unable to cancel job.");
    return superadminJson({ error: mapped.error }, { status: mapped.status });
  }
  if (!job) return superadminJson({ error: "Unable to cancel job." }, { status: 500 });
  const typedJob = job as { uploadId: string; status: string };

  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "admin",
    action: "superadmin_job_cancel",
    message: "Superadmin cancelled an import job.",
    status: "completed",
    metadata: { jobRef: id.slice(0, 8), uploadRef: typedJob.uploadId.slice(0, 8) }
  });
  return superadminJson({ ok: true, jobId: id, uploadId: typedJob.uploadId, status: typedJob.status });
}
