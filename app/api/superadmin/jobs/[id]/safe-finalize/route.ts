import { NextResponse } from "next/server";
import { assertCriticalSameOrigin, requireSuperadmin, superadminJson } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";
import { finalizeImportJobSafely } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertCriticalSameOrigin(request);
  if (csrf) return csrf;
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const result = await finalizeImportJobSafely(context.service, id, { actorId: context.profile.id, reason: "Superadmin safe finalize requested." });

  if (!result.diagnostics) return superadminJson({ error: "Import job not found." }, { status: 404 });
  if (!result.finalized) {
    return superadminJson({ error: "Safe finalize is not available for this job.", diagnostics: result.diagnostics }, { status: 409 });
  }

  await logger.audit({
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    route: new URL(request.url).pathname,
    method: request.method,
    ipAddress: requestIp(request),
    userAgent: request.headers.get("user-agent") ?? "unknown",
    module: "admin",
    action: "superadmin_job_safe_finalize",
    message: "Superadmin safe-finalized an import job.",
    status: "completed",
    metadata: { jobId: id, uploadBatchId: result.diagnostics.job.upload_batch_id, status: result.status }
  });

  return superadminJson({ ok: true, jobId: id, uploadId: result.diagnostics.job.upload_batch_id, status: result.status });
}
