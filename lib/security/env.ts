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

export function getOptionalNumberEnv(name: string) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function getRowsPerFileLimit() {
  const explicit = Number(process.env.MAX_ROWS_PER_FILE);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const legacy = Number(process.env.MAX_EXCEL_ROWS);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;

  return 100_000;
}

export const SECURITY_LIMITS = {
  get maxUploadSizeBytes() {
    return getNumberEnv("MAX_UPLOAD_SIZE_MB", 25) * 1024 * 1024;
  },
  get uploadChunkSizeBytes() {
    return getNumberEnv("UPLOAD_CHUNK_SIZE_MB", 8) * 1024 * 1024;
  },
  get uploadTimeoutSeconds() {
    return getNumberEnv("UPLOAD_TIMEOUT_SECONDS", 60);
  },
  get resumableThresholdBytes() {
    return getNumberEnv("LARGE_UPLOAD_RESUMABLE_THRESHOLD_MB", 100) * 1024 * 1024;
  },
  get maxExcelRows() {
    return getRowsPerFileLimit();
  },
  get maxExcelSheets() {
    return getNumberEnv("MAX_EXCEL_SHEETS", 30);
  },
  get uploadChunkSize() {
    return getNumberEnv("SUPABASE_INSERT_CHUNK_SIZE", 500);
  },
  get importBatchSize() {
    return getNumberEnv("IMPORT_BATCH_SIZE", getNumberEnv("SUPABASE_INSERT_CHUNK_SIZE", 500));
  },
  get workerConcurrency() {
    return getNumberEnv("WORKER_CONCURRENCY", 1);
  },
  get workerPollIntervalMs() {
    return getNumberEnv("WORKER_POLL_INTERVAL_MS", 5000);
  },
  get workerStaleAfterMinutes() {
    return getNumberEnv("WORKER_STALE_AFTER_MINUTES", 30);
  },
  get workerMaxAttempts() {
    return getNumberEnv("WORKER_MAX_ATTEMPTS", 3);
  },
  get workerHeartbeatIntervalMs() {
    return getNumberEnv("WORKER_HEARTBEAT_INTERVAL_MS", 15000);
  },
  get importMaxErrorsPerJob() {
    return getNumberEnv("IMPORT_MAX_ERRORS_PER_JOB", 5000);
  },
  get importMaxErrorsPerRow() {
    return getNumberEnv("IMPORT_MAX_ERRORS_PER_ROW", 5);
  },
  get treatValidationAsWarnings() {
    return process.env.IMPORT_TREAT_VALIDATION_AS_WARNINGS !== "false";
  },
  get allowPartialRows() {
    return process.env.IMPORT_ALLOW_PARTIAL_ROWS !== "false";
  }
};
