type SupabaseLikeError = { code?: string | null; message?: string | null } | null | undefined;

export function importLifecycleError(error: SupabaseLikeError, fallback: string) {
  const diagnostic = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/IMPORT_JOB_NOT_FOUND/.test(diagnostic)) return { status: 404, error: "Import job not found." };
  if (/IMPORT_JOB_ACCESS_DENIED|IMPORT_PROVENANCE_INVALID/.test(diagnostic)) {
    return { status: 403, error: "You cannot manage this import job." };
  }
  if (/IMPORT_(?:CANCEL|RETRY|FINALIZE)_STATE_INVALID|IMPORT_SAFE_FINALIZE_NOT_AVAILABLE/.test(diagnostic)) {
    return { status: 409, error: "The import job is not in a valid state for this action." };
  }
  if (/IMPORT_STORAGE_(?:OBJECT_MISSING|SIZE_UNVERIFIED|SIZE_MISMATCH)/.test(diagnostic)) {
    return { status: 409, error: "The uploaded file could not be verified safely." };
  }
  return { status: 500, error: fallback };
}
