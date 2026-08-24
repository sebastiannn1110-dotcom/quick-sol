import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";
import { getImportJobDiagnostics } from "@/lib/upload/job-diagnostics";
import { importLifecycleError } from "@/lib/upload/lifecycle-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const diagnostics = await getImportJobDiagnostics(context.service, id, { trustedBackend: true });
  if (diagnostics?.safeFinalize.possible) {
    return superadminJson({
      error: "This job appears fully imported. Use safe finalize instead of retrying.",
      diagnostics
    }, { status: 409 });
  }

  const { data: job, error } = await context.service.rpc("request_import_job_retry_v2", {
    input_actor_id: context.profile.id,
    input_job_id: id
  });
  if (error) {
    const mapped = importLifecycleError(error, "Unable to retry job.");
    return superadminJson({ error: mapped.error }, { status: mapped.status });
  }
  if (!job) return superadminJson({ error: "Unable to retry job." }, { status: 500 });
  const typedJob = job as { upload_batch_id: string };

  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "admin",
    action: "superadmin_job_retry",
    message: "Superadmin retried an import job.",
    status: "completed",
    metadata: { jobRef: id.slice(0, 8), uploadRef: typedJob.upload_batch_id.slice(0, 8) }
  });
  return superadminJson({ ok: true, jobId: id, uploadId: typedJob.upload_batch_id });
}
