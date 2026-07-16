import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadmin/auth";
import { logger } from "@/lib/logger/logger";
import { requestIp } from "@/lib/security/rateLimit";
import { finalizeImportJobSafely } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const result = await finalizeImportJobSafely(context.service, id, { reason: "Superadmin safe finalize requested." });

  if (!result.diagnostics) return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  if (!result.finalized) {
    return NextResponse.json({ error: "Safe finalize is not available for this job.", diagnostics: result.diagnostics }, { status: 409 });
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

  return NextResponse.json({ ok: true, jobId: id, uploadId: result.diagnostics.job.upload_batch_id, status: result.status });
}
