import { NextResponse } from "next/server";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { uploadId } = await params;
  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Service role key is not configured." }, { status: 503 });

  const { data: upload, error } = await service
    .from("upload_batches")
    .select("id, original_file_name, stored_file_path")
    .eq("id", uploadId)
    .single();

  if (error || !upload?.stored_file_path) {
    return NextResponse.json({ error: "Excel file is not available for this upload." }, { status: 404 });
  }

  const { data, error: signedUrlError } = await service.storage
    .from("excel-uploads")
    .createSignedUrl(upload.stored_file_path, 300, {
      download: upload.original_file_name
    });

  if (signedUrlError || !data?.signedUrl) {
    return NextResponse.json({ error: "Unable to create a secure Excel download link." }, { status: 500 });
  }

  await logAuditEvent(context, "admin_excel_opened", "upload_batch", upload.id, {
    fileName: upload.original_file_name
  });

  return NextResponse.redirect(data.signedUrl);
}
