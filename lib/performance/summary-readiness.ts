import type { SupabaseClient } from "@supabase/supabase-js";

export const SUMMARY_LIFECYCLE_STATUSES = [
  "ready",
  "queued",
  "rebuilding",
  "retrying",
  "failed",
  "stale",
  "contract_unavailable"
] as const;

export type SummaryLifecycleStatus = typeof SUMMARY_LIFECYCLE_STATUSES[number];

export type SummaryReadState = {
  status: SummaryLifecycleStatus;
  currentVersion: number | null;
  requiredVersion: number | null;
  retryable: boolean;
  retryAfterSeconds: number;
  currentVersionMin?: number | null;
  currentVersionMax?: number | null;
  requiredVersionMin?: number | null;
  requiredVersionMax?: number | null;
  pendingCount?: number;
  totalScopes?: number;
  missingVersionCount?: number;
};

export type SummaryUnavailablePayload = SummaryReadState & {
  error: string;
  errorCode: "SUMMARY_NOT_READY" | "SUMMARY_REBUILD_FAILED" | "SUMMARY_CONTRACT_UNAVAILABLE";
  summaryStatus: Exclude<SummaryLifecycleStatus, "ready">;
};

type PostgrestErrorLike = {
  code?: string | null;
  message?: string | null;
};

const CONTRACT_UNAVAILABLE_CODES = new Set(["PGRST202", "42883"]);
const DEFAULT_RETRY_SECONDS: Record<Exclude<SummaryLifecycleStatus, "ready">, number> = {
  queued: 3,
  rebuilding: 3,
  retrying: 5,
  stale: 3,
  failed: 30,
  contract_unavailable: 60
};

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function unwrapSummaryRpcData(value: unknown) {
  if (!Array.isArray(value)) return value;
  if (value.length === 1) return value[0];
  return value;
}

function firstValue(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function finiteVersion(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteCount(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stateMetadata(row: Record<string, unknown>) {
  const metadata: Pick<SummaryReadState,
    "currentVersionMin" | "currentVersionMax" | "requiredVersionMin" | "requiredVersionMax"
    | "pendingCount" | "totalScopes" | "missingVersionCount"> = {};
  for (const [property, keys] of [
    ["currentVersionMin", ["currentVersionMin", "current_version_min"]],
    ["currentVersionMax", ["currentVersionMax", "current_version_max"]],
    ["requiredVersionMin", ["requiredVersionMin", "required_version_min"]],
    ["requiredVersionMax", ["requiredVersionMax", "required_version_max"]]
  ] as const) {
    if (keys.some((key) => row[key] !== undefined)) metadata[property] = finiteVersion(firstValue(row, [...keys]));
  }
  for (const [property, keys] of [
    ["pendingCount", ["pendingCount", "pending_count"]],
    ["totalScopes", ["totalScopes", "total_scopes"]],
    ["missingVersionCount", ["missingVersionCount", "missing_version_count"]]
  ] as const) {
    const count = finiteCount(firstValue(row, [...keys]));
    if (count !== null) metadata[property] = count;
  }
  return metadata;
}

function retrySeconds(value: unknown, status: Exclude<SummaryLifecycleStatus, "ready">) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return Math.min(Math.max(Math.floor(parsed), 1), 60);
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    return Math.min(Math.max(Math.ceil((timestamp - Date.now()) / 1000), 1), 60);
  }
  return DEFAULT_RETRY_SECONDS[status];
}

function explicitStatus(value: unknown): SummaryLifecycleStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return (SUMMARY_LIFECYCLE_STATUSES as readonly string[]).includes(normalized)
    ? normalized as SummaryLifecycleStatus
    : null;
}

export function isSummaryContractUnavailable(error: PostgrestErrorLike | null | undefined) {
  return Boolean(error && CONTRACT_UNAVAILABLE_CODES.has(error.code ?? ""));
}

export function summaryReadState(
  data: unknown,
  error?: PostgrestErrorLike | null,
  missingRowStatus: Exclude<SummaryLifecycleStatus, "ready" | "contract_unavailable"> = "stale"
): SummaryReadState {
  if (error) {
    const status = isSummaryContractUnavailable(error) ? "contract_unavailable" : "failed";
    return {
      status,
      currentVersion: null,
      requiredVersion: null,
      retryable: status === "failed",
      retryAfterSeconds: DEFAULT_RETRY_SECONDS[status]
    };
  }

  const row = recordValue(unwrapSummaryRpcData(data));
  if (!row) {
    return {
      status: "contract_unavailable",
      currentVersion: null,
      requiredVersion: null,
      retryable: false,
      retryAfterSeconds: DEFAULT_RETRY_SECONDS.contract_unavailable
    };
  }

  const readyValue = firstValue(row, ["summaryReady", "summary_ready", "ready"]);
  const namedStatus = explicitStatus(firstValue(row, [
    "summaryStatus",
    "summary_status",
    "rebuildStatus",
    "rebuild_status",
    "status"
  ]));
  const status = readyValue === true
    ? "ready"
    : namedStatus === "ready" && readyValue !== false
      ? "ready"
      : namedStatus && namedStatus !== "contract_unavailable"
        ? namedStatus
        : readyValue === false
          ? missingRowStatus
          : "contract_unavailable";
  const currentVersion = finiteVersion(firstValue(row, [
    "currentVersion",
    "current_version",
    "publishedVersion",
    "published_version",
    "summaryVersion",
    "summary_version"
  ]));
  const requiredVersion = finiteVersion(firstValue(row, [
    "requiredVersion",
    "required_version",
    "sourceVersion",
    "source_version",
    "dataVersion",
    "data_version"
  ]));
  const metadata = stateMetadata(row);

  if (status === "ready") {
    return { status, currentVersion, requiredVersion, retryable: false, retryAfterSeconds: 0, ...metadata };
  }

  return {
    status,
    currentVersion,
    requiredVersion,
    retryable: status !== "contract_unavailable",
    retryAfterSeconds: retrySeconds(
      firstValue(row, ["retryAfterSeconds", "retry_after_seconds", "retryAfter", "retry_after"]),
      status
    ),
    ...metadata
  };
}

export async function loadBusinessSummaryState(
  supabase: SupabaseClient,
  scope: { uploadBatchId?: string | null; clientId?: string | null } = {}
) {
  const result = await supabase.rpc("get_business_summary_state_v2", {
    p_upload_batch_id: scope.uploadBatchId ?? null,
    p_client_id: scope.clientId ?? null
  });
  return summaryReadState(result.data, result.error);
}

export async function requestBusinessSummaryRebuild(
  supabase: SupabaseClient,
  scope: { uploadBatchId?: string | null; clientId?: string | null } = {}
) {
  const result = await supabase.rpc("request_business_summary_rebuild_v2", {
    input_upload_batch_id: scope.uploadBatchId ?? null,
    input_client_id: scope.clientId ?? null
  });
  if (result.error) throw result.error;
  const row = recordValue(unwrapSummaryRpcData(result.data));
  const requestedCount = Number(row?.requestedCount);
  const status = row?.status;
  if (
    !Number.isSafeInteger(requestedCount)
    || requestedCount < 0
    || requestedCount > 100
    || (status !== "queued" && status !== "noop")
  ) throw new Error("SUMMARY_REBUILD_PROTOCOL_INVALID");
  return { requestedCount, status } as const;
}

export async function requestBusinessSummaryRebuildFromUi(
  scope: { uploadBatchId?: string | null; clientId?: string | null } = {},
  signal?: AbortSignal
) {
  const response = await fetch("/api/business-summary/rebuild", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scope),
    signal
  });
  if (!response.ok) throw new Error("SUMMARY_REBUILD_REQUEST_FAILED");
  return response.json() as Promise<{ requestedCount: number; status: "queued" | "noop" }>;
}

export async function requireBusinessSummaryReady(
  supabase: SupabaseClient,
  scope: { uploadBatchId?: string | null; clientId?: string | null } = {}
) {
  const state = await loadBusinessSummaryState(supabase, scope);
  if (state.status !== "ready") throw new SummaryUnavailableError(state);
  return state;
}

export class SummaryUnavailableError extends Error {
  readonly state: SummaryReadState;

  constructor(state: SummaryReadState) {
    super(state.status === "contract_unavailable" ? "SUMMARY_CONTRACT_UNAVAILABLE" : "SUMMARY_NOT_READY");
    this.name = "SummaryUnavailableError";
    this.state = state;
  }
}

export function requireReadySummary<T>(data: unknown, error?: PostgrestErrorLike | null) {
  if (error) {
    if (isSummaryContractUnavailable(error)) {
      throw new SummaryUnavailableError(summaryReadState(null, error));
    }
    const rpcError = new Error("SUMMARY_DATA_READ_FAILED") as Error & { code?: string | null };
    rpcError.code = error.code;
    throw rpcError;
  }
  const unwrapped = unwrapSummaryRpcData(data);
  if (unwrapped === null || unwrapped === undefined) throw new Error("SUMMARY_DATA_PROTOCOL_INVALID");
  const row = recordValue(unwrapped);
  if (!row) throw new Error("SUMMARY_DATA_PROTOCOL_INVALID");
  const postReadFence = firstValue(row, ["summaryReady", "summary_ready", "ready"]);
  // State v2 is the preflight authority, while the embedded v1 flag remains a
  // required post-read fence: a business write may dirty the scope between the
  // two RPC calls. Never publish that stale page as zero/ready data.
  if (postReadFence !== true) throw new SummaryUnavailableError(summaryReadState(row));
  return unwrapped as T;
}

export function isSummaryUnavailableError(value: unknown): value is SummaryUnavailableError {
  return value instanceof SummaryUnavailableError;
}

export function summaryUnavailablePayload(state: SummaryReadState): SummaryUnavailablePayload {
  if (state.status === "ready") throw new Error("SUMMARY_IS_READY");
  const errorCode = state.status === "contract_unavailable"
    ? "SUMMARY_CONTRACT_UNAVAILABLE"
    : state.status === "failed"
      ? "SUMMARY_REBUILD_FAILED"
      : "SUMMARY_NOT_READY";
  return {
    error: state.status === "contract_unavailable"
      ? "The summary contract is unavailable."
      : state.status === "failed"
        ? "The summary rebuild failed."
        : "The summary is not ready yet.",
    errorCode,
    summaryStatus: state.status,
    status: state.status,
    currentVersion: state.currentVersion,
    requiredVersion: state.requiredVersion,
    retryable: state.retryable,
    retryAfterSeconds: state.retryAfterSeconds
  };
}

export function summaryUnavailableHttpStatus(state: SummaryReadState) {
  return state.status === "failed" || state.status === "contract_unavailable" ? 503 : 409;
}

export function summaryResponseHeaders(state?: SummaryReadState) {
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store, max-age=0"
  };
  if (state && state.status !== "ready") headers["Retry-After"] = String(state.retryAfterSeconds);
  return headers;
}

export function parseSummaryUnavailablePayload(value: unknown): SummaryUnavailablePayload | null {
  const row = recordValue(value);
  if (!row) return null;
  const errorCode = String(row.errorCode ?? "");
  if (!["SUMMARY_NOT_READY", "SUMMARY_REBUILD_FAILED", "SUMMARY_CONTRACT_UNAVAILABLE"].includes(errorCode)) return null;
  const status = explicitStatus(row.summaryStatus ?? row.status);
  if (!status || status === "ready") return null;
  const state: SummaryReadState = {
    status,
    currentVersion: finiteVersion(row.currentVersion),
    requiredVersion: finiteVersion(row.requiredVersion),
    retryable: row.retryable === true,
    retryAfterSeconds: retrySeconds(row.retryAfterSeconds, status),
    ...stateMetadata(row)
  };
  return {
    error: typeof row.error === "string" ? row.error : "The summary is unavailable.",
    errorCode: errorCode as SummaryUnavailablePayload["errorCode"],
    summaryStatus: status,
    ...state
  };
}

const STATUS_PRIORITY: Record<SummaryLifecycleStatus, number> = {
  ready: 0,
  stale: 1,
  queued: 2,
  rebuilding: 3,
  retrying: 3,
  failed: 4,
  contract_unavailable: 5
};

export function aggregateSummaryStates(states: SummaryReadState[]): SummaryReadState {
  if (!states.length) return {
    status: "ready",
    currentVersion: null,
    requiredVersion: null,
    retryable: false,
    retryAfterSeconds: 0
  };
  const selected = states.reduce((current, candidate) =>
    STATUS_PRIORITY[candidate.status] > STATUS_PRIORITY[current.status] ? candidate : current
  );
  return {
    ...selected,
    currentVersion: states.reduce<number | null>((minimum, state) => {
      if (state.currentVersion === null) return minimum;
      return minimum === null ? state.currentVersion : Math.min(minimum, state.currentVersion);
    }, null),
    requiredVersion: states.reduce<number | null>((maximum, state) => {
      if (state.requiredVersion === null) return maximum;
      return maximum === null ? state.requiredVersion : Math.max(maximum, state.requiredVersion);
    }, null)
  };
}
