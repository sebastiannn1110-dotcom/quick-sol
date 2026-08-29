import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingError, sourcingNoStore } from "@/lib/sourcing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Private sourcing storage is not configured.");
  const attachmentId = z.string().uuid().safeParse((await params).attachmentId);
  if (!attachmentId.success) return sourcingError(422, "SOURCING_VALIDATION_ERROR", "Invalid attachment id.");
  const { data: attachment, error } = await context.supabase.from("sourcing_offer_attachments")
    .select("storage_bucket,storage_path,original_file_name")
    .eq("id", attachmentId.data).maybeSingle();
  if (error || !attachment) return sourcingError(404, "SOURCING_NOT_FOUND", "The attachment was not found.");
  const signed = await context.supabase.storage.from(attachment.storage_bucket)
    .createSignedUrl(attachment.storage_path, 60, { download: attachment.original_file_name });
  if (signed.error) return sourcingError(500, "SOURCING_ATTACHMENT_FAILED", "A signed download could not be created.");
  return sourcingNoStore({ data: { url: signed.data.signedUrl, expiresIn: 60 } });
}
