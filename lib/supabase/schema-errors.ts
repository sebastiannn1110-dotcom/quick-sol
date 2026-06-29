export interface SupabaseErrorLike {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

export function getSupabaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as SupabaseErrorLike).code ?? "")
    : "";
}

export function isMissingSchemaError(error: unknown) {
  const code = getSupabaseErrorCode(error);
  if (code === "PGRST202" || code === "PGRST205" || code === "42703") return true;

  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as SupabaseErrorLike).message ?? "")
    : "";

  return /could not find the (table|function)|column .* does not exist/i.test(message);
}

export function schemaErrorMetadata(error: unknown, requiredMigration: string) {
  const supabaseError = (typeof error === "object" && error !== null ? error : {}) as SupabaseErrorLike;
  return {
    requiredMigration,
    code: supabaseError.code,
    message: supabaseError.message,
    details: supabaseError.details,
    hint: supabaseError.hint
  };
}

export function missingMigrationMessage(feature: string) {
  return `La base de datos no tiene aplicada la migracion requerida para ${feature}.`;
}
