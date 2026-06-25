import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { logger } from "@/lib/logger/logger";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STORAGE_ACCESS_MESSAGE =
  "Server storage access is not configured. Please add SUPABASE_SERVICE_ROLE_KEY in Render environment variables.";

export async function GET(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { uploadId } = await params;
  const service = createSupabaseAdminClient();
  if (!service) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      method: "GET",
      module: "supabase",
      action: "service_role_missing",
      message: STORAGE_ACCESS_MESSAGE,
      status: "failed",
      uploadBatchId: uploadId
    });
    return NextResponse.json({ error: STORAGE_ACCESS_MESSAGE }, { status: 503 });
  }

  const { data: upload, error } = await service
    .from("upload_batches")
    .select("id, original_file_name, stored_file_path")
    .eq("id", uploadId)
    .single();

  if (error || !upload?.stored_file_path) {
    await logger.warn({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      method: "GET",
      module: "supabase",
      action: "excel_file_missing",
      message: "Original Excel file is not available for this upload.",
      status: "failed",
      uploadBatchId: uploadId,
      error
    });
    return NextResponse.json({ error: "Original Excel file is not available for this upload." }, { status: 404 });
  }

  const { data, error: signedUrlError } = await service.storage
    .from("excel-uploads")
    .createSignedUrl(upload.stored_file_path, 120, {
      download: upload.original_file_name
    });

  if (signedUrlError || !data?.signedUrl) {
    await logger.error({
      traceId: context.requestMeta.traceId,
      requestId: context.requestMeta.requestId,
      userId: context.profile.id,
      userEmail: context.profile.email,
      userRole: context.profile.role,
      route: context.requestMeta.route,
      method: "GET",
      module: "supabase",
      action: "excel_signed_url_failed",
      message: "Unable to create a secure Excel signed URL.",
      status: "failed",
      uploadBatchId: upload.id,
      error: signedUrlError
    });
    return NextResponse.json({ error: "Unable to create a secure Excel download link." }, { status: 500 });
  }

  await logAuditEvent(context, "admin_opened_employee_excel", "upload_batch", upload.id, {
    fileName: upload.original_file_name
  });

  return NextResponse.redirect(data.signedUrl);
}
