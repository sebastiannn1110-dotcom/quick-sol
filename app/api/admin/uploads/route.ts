import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const { searchParams } = new URL(request.url);
  const employee = searchParams.get("employee");

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    return NextResponse.json({ uploads: data.uploads });
  }

  let query = context.supabase!
    .from("upload_batches")
    .select("*, profiles(full_name,email,department,region,role)")
    .order("created_at", { ascending: false })
    .limit(500);

  if (employee) query = query.eq("uploaded_by", employee);

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: "Unable to load uploads." }, { status: 500 });
  const uploads = data ?? [];
  const uploadIds = uploads.map((upload) => upload.id);
  if (!uploadIds.length) return NextResponse.json({ uploads });

  const { data: jobs } = await context.supabase!
    .from("import_jobs")
    .select("id,upload_batch_id,status,total_rows,processed_rows,successful_rows,failed_rows,warning_count,rows_with_warnings,technical_error_count,suppressed_error_count,progress_percent,error_message,attempts,max_attempts,locked_by,heartbeat_at,next_retry_at,last_error,created_at")
    .in("upload_batch_id", uploadIds)
    .order("created_at", { ascending: false });

  const latestJobByUpload = new Map<string, unknown>();
  for (const job of jobs ?? []) {
    if (!latestJobByUpload.has(job.upload_batch_id)) latestJobByUpload.set(job.upload_batch_id, job);
  }

  return NextResponse.json({
    uploads: uploads.map((upload) => ({
      ...upload,
      latest_import_job: latestJobByUpload.get(upload.id) ?? null
    }))
  });
}

export async function PATCH(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const body = (await request.json()) as { uploadBatchId?: string; action?: string };

  if (!body.uploadBatchId || body.action !== "archive") {
    return NextResponse.json({ error: "Unsupported upload action." }, { status: 400 });
  }

  if (context.isDemoMode) return NextResponse.json({ ok: true, demo: true });

  const { data, error } = await context.supabase!
    .from("upload_batches")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", body.uploadBatchId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: "Unable to archive upload." }, { status: 500 });

  await logAuditEvent(context, "admin_upload_archived", "upload_batch", body.uploadBatchId);
  return NextResponse.json({ upload: data });
}
