import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, PermissionError, SupabaseError } from "@/lib/errors/AppError";

type PostgrestErrorLike = { code?: string | null } | null;

function assignmentError(input: {
  code: string;
  message: string;
  statusCode: number;
  safeMessage: string;
}) {
  return new AppError({
    ...input,
    severity: input.statusCode >= 500 ? "high" : "medium"
  });
}

export async function loadAssignableUploadClient(supabase: SupabaseClient, clientId: string) {
  const { data, error } = await supabase
    .from("clients")
    .select("id,name")
    .eq("id", clientId)
    .eq("status", "active")
    .is("archived_at", null)
    .maybeSingle();

  if (error) throw new SupabaseError("Unable to verify upload client.", { table: "clients", errorCode: error.code });
  if (!data) {
    throw assignmentError({
      code: "UPLOAD_CLIENT_NOT_FOUND",
      message: "Upload client was not found in the actor scope.",
      statusCode: 404,
      safeMessage: "La empresa seleccionada no existe o no está disponible."
    });
  }
  return data as { id: string; name: string };
}

async function loadExistingAssignment(supabase: SupabaseClient, uploadBatchId: string) {
  const { data, error } = await supabase
    .from("client_upload_assignments")
    .select("client_id,upload_batch_id")
    .eq("upload_batch_id", uploadBatchId)
    .maybeSingle();
  if (error) throw new SupabaseError("Unable to inspect upload assignment.", {
    table: "client_upload_assignments",
    errorCode: error.code
  });
  return data as { client_id: string; upload_batch_id: string } | null;
}

function assertSameClient(existingClientId: string, requestedClientId: string) {
  if (existingClientId === requestedClientId) return;
  throw assignmentError({
    code: "UPLOAD_CLIENT_CONFLICT",
    message: "Upload is already assigned to a different client.",
    statusCode: 409,
    safeMessage: "Este archivo ya está asociado a otra empresa."
  });
}

export async function ensureClientUploadAssignment(
  supabase: SupabaseClient,
  input: { actorId: string; clientId: string; uploadBatchId: string }
) {
  const { data: upload, error: uploadError } = await supabase
    .from("upload_batches")
    .select("id,uploaded_by")
    .eq("id", input.uploadBatchId)
    .is("archived_at", null)
    .maybeSingle();

  if (uploadError) throw new SupabaseError("Unable to verify upload ownership.", {
    table: "upload_batches",
    errorCode: uploadError.code
  });
  if (!upload) throw new PermissionError("Upload does not belong to the actor scope.", { uploadRef: input.uploadBatchId.slice(0, 8) });

  const existing = await loadExistingAssignment(supabase, input.uploadBatchId);
  if (existing) {
    assertSameClient(existing.client_id, input.clientId);
    return { created: false } as const;
  }

  const { error } = await supabase.from("client_upload_assignments").insert({
    client_id: input.clientId,
    upload_batch_id: input.uploadBatchId,
    assigned_by: input.actorId
  });
  if (!error) return { created: true } as const;

  if ((error as PostgrestErrorLike)?.code === "23505") {
    const raced = await loadExistingAssignment(supabase, input.uploadBatchId);
    if (raced) {
      assertSameClient(raced.client_id, input.clientId);
      return { created: false } as const;
    }
  }
  if ((error as PostgrestErrorLike)?.code === "42501") {
    throw new PermissionError("RLS rejected the client upload assignment.");
  }
  throw new SupabaseError("Unable to assign upload to client.", {
    table: "client_upload_assignments",
    errorCode: (error as PostgrestErrorLike)?.code
  });
}
