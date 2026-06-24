export function getRequiredServerEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }
  return value;
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabasePublishableKey()
  );
}

export function getSupabasePublishableKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  );
}

export function isServiceRoleConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function isDemoModeAllowed() {
  return process.env.NODE_ENV !== "production" && !isSupabaseConfigured();
}

export function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const SECURITY_LIMITS = {
  maxUploadSizeBytes: getNumberEnv("MAX_UPLOAD_SIZE_MB", 25) * 1024 * 1024,
  maxExcelRows: getNumberEnv("MAX_EXCEL_ROWS", 20000),
  maxExcelSheets: getNumberEnv("MAX_EXCEL_SHEETS", 30),
  uploadChunkSize: getNumberEnv("SUPABASE_INSERT_CHUNK_SIZE", 500)
};
