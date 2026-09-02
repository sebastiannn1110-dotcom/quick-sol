import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSourcingManager } from "@/lib/sourcing/auth";
import { sourcingError, sourcingNoStore } from "@/lib/sourcing/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

function safeFileName(value: string) {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").slice(-160) || "attachment";
}

export async function POST(request: Request) {
  const context = await requireSourcingManager(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return sourcingError(503, "SOURCING_NOT_CONFIGURED", "Private sourcing storage is not configured.");
  const form = await request.formData().catch(() => null);
  const requestId = z.string().uuid().safeParse(form?.get("requestId"));
  const rawOfferId = form?.get("offerId");
  const offerId = rawOfferId ? z.string().uuid().safeParse(rawOfferId) : null;
  const file = form?.get("file");
  if (!requestId.success || (offerId && !offerId.success) || !(file instanceof File)) {
    return sourcingError(422, "SOURCING_VALIDATION_ERROR", "A valid request and file are required.");
  }
  if (file.size < 1 || file.size > 10 * 1024 * 1024 || !ALLOWED_TYPES.has(file.type)) {
    return sourcingError(415, "SOURCING_ATTACHMENT_REJECTED", "Unsupported attachment type or size.");
  }
  const { data: sourcingRequest } = await context.supabase
    .from("sourcing_requests").select("id").eq("id", requestId.data).maybeSingle();
  if (!sourcingRequest) return sourcingError(404, "SOURCING_NOT_FOUND", "The sourcing request was not found.");
  if (offerId?.success) {
    const { data: offer } = await context.supabase.from("sourcing_offers")
      .select("id").eq("id", offerId.data).eq("sourcing_request_id", requestId.data).maybeSingle();
    if (!offer) return sourcingError(422, "SOURCING_ATTACHMENT_MISMATCH", "The offer does not belong to the request.");
  }
  const storagePath = `${requestId.data}/${randomUUID()}-${safeFileName(file.name)}`;
  const uploaded = await context.supabase.storage.from("sourcing-private")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploaded.error) return sourcingError(500, "SOURCING_ATTACHMENT_FAILED", "The private attachment could not be stored.");
  const inserted = await context.supabase.from("sourcing_offer_attachments").insert({
    sourcing_request_id: requestId.data,
    sourcing_offer_id: offerId?.success ? offerId.data : null,
    storage_bucket: "sourcing-private",
    storage_path: storagePath,
    original_file_name: file.name.slice(0, 255),
    mime_type: file.type,
    size_bytes: file.size,
    uploaded_by: context.profile.id
  }).select("id,original_file_name,size_bytes,created_at").single();
  if (inserted.error) {
    await context.supabase.storage.from("sourcing-private").remove([storagePath]);
    return sourcingError(500, "SOURCING_ATTACHMENT_FAILED", "The attachment metadata could not be stored.");
  }
  return sourcingNoStore({ data: inserted.data }, 201);
}
