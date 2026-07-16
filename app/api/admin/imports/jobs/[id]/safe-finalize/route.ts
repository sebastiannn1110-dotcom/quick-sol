import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { finalizeImportJobSafely } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required." }, { status: 503 });

  const { id } = await params;
  const result = await finalizeImportJobSafely(context.supabase, id, { reason: "Admin safe finalize requested." });
  if (!result.diagnostics) return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  if (!result.finalized) {
    return NextResponse.json({ error: "Safe finalize is not available for this job.", diagnostics: result.diagnostics }, { status: 409 });
  }

  await logAuditEvent(context, "admin_import_job_safe_finalized", "upload_batch", result.diagnostics.job.upload_batch_id, { jobId: id });
  return NextResponse.json({ ok: true, status: result.status, diagnostics: result.diagnostics });
}
