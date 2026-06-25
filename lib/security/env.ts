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

export function isValidSupabasePublicKey(value: string | undefined) {
  const key = value?.trim();
  return Boolean(key && (key.startsWith("sb_publishable_") || key.startsWith("eyJ")));
}

export function getSupabasePublishableKey() {
  const candidates = [
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ];

  return candidates.find(isValidSupabasePublicKey)?.trim() ?? "";
}

export function isServiceRoleConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && getSupabaseServiceRoleKey()
  );
}

export function getSupabaseServiceRoleKey() {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
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
