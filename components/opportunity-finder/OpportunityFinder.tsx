"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  CircleX,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud
} from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import OpportunityCard from "@/components/opportunity-finder/OpportunityCard";
import { evaluateOpportunityCompatibility } from "@/lib/opportunity-finder/compatibility";
import { sha256OpportunityFileContents } from "@/lib/opportunity-finder/pipeline";
import {
  abortRequest,
  isAbortError,
  isExpectedAbort,
  requestAbortError,
  throwIfRequestAborted
} from "@/lib/request-lifecycle";
import {
  FILE_TYPE_LABELS,
  OPPORTUNITY_TYPE_LABELS,
  ROLE_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  opportunityFinderCopy
} from "@/lib/opportunity-finder/i18n";
import type {
  OpportunityComparisonMode,
  OpportunityFileType,
  OpportunityJobStage,
  OpportunityJobStatus,
  OpportunityColumnMapping,
  OpportunityConfidence,
  OpportunityRejectedRow,
  OpportunityResult,
  OpportunitySelectedRole,
  OpportunitySheetProfile,
  OpportunitySourceTrace,
  OpportunitySummary,
  OpportunityType
} from "@/lib/opportunity-finder/types";

type ApiFile = {
  id: string;
  side: "A" | "B";
  originalFileName: string;
  mimeType: string | null;
  sizeBytes: number;
  detectedType: OpportunityFileType;
  selectedRole: OpportunitySelectedRole | null;
  classificationScore: number;
  classificationReasons: string[];
  sheets: OpportunitySheetProfile[];
  sheetCount: number;
  rowCount: number;
  usefulRowCount: number;
  hiddenRowCount: number;
  templateType: string | null;
  mappingVersion: string | null;
  columnMappings: OpportunityColumnMapping[];
  warnings: string[];
  errors: string[];
  actualSizeBytes: number | null;
  contentVerified: boolean;
  validationStatus: string | null;
  parseStatus: string;
  storageDeletedAt: string | null;
  sourceKind?: "uploaded" | "platform_snapshot";
};

type ApiJob = {
  id: string;
  status: OpportunityJobStatus;
  currentStage: OpportunityJobStage;
  progressPercent: number;
  fileARole: OpportunitySelectedRole | null;
  fileBRole: OpportunitySelectedRole | null;
  totalRowsA: number;
  totalRowsB: number;
  processedRows: number;
  resultCount: number;
  warningCount: number;
  clientContext: string | null;
  summary: Partial<OpportunitySummary>;
  errorCode: string | null;
  pipelineVersion: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  comparisonMode?: OpportunityComparisonMode;
  uploadedRole?: OpportunitySelectedRole | null;
  oppositeDatasetRole?: "demand" | "stock" | null;
  snapshotStatus?: "not_required" | "pending" | "ready" | "failed";
  datasetVersion?: string | null;
  existingEntityCount?: number;
};

type JobResponse = {
  job: ApiJob;
  files: ApiFile[];
  results: OpportunityResult[];
  possibleMatches: Array<{
    id: string;
    demandDisplayMpn: string;
    supplyDisplayMpn: string;
    reasonCode: string;
    matchTier?: string | null;
    confidence?: OpportunityConfidence;
    explanation?: string | null;
    reviewStatus?: "not_required" | "pending" | "approved" | "rejected";
    manufacturerCompatible?: boolean;
    demandTrace?: OpportunitySourceTrace | null;
    supplyTrace?: OpportunitySourceTrace | null;
  }>;
  rejectedRows: Array<OpportunityRejectedRow & { id: string }>;
  capabilities: {
    canViewPricing: boolean;
    canViewFinancials: boolean;
  };
  page: { offset: number; limit: number; total: number };
};

type SignedFile = {
  id: string;
  side: "A" | "B";
  signedUrl: string;
};

type ReusedComparison = {
  jobId: string;
  status: OpportunityJobStatus;
  createdAt: string | null;
  pipelineVersion: string | null;
};

type OpportunityApiError = Error & {
  reasonCode?: string;
  jobId?: string;
  status?: OpportunityJobStatus;
  reusedExistingJob?: boolean;
  createdAt?: string | null;
  pipelineVersion?: string | null;
};

type FilterState = {
  q: string;
  manufacturer: string;
  context: string;
  opportunityType: "" | OpportunityType;
  fileId: string;
  exactOnly: boolean;
  withShortage: boolean;
  withAvailable: boolean;
};

const EMPTY_FILTERS: FilterState = {
  q: "",
  manufacturer: "",
  context: "",
  opportunityType: "",
  fileId: "",
  exactOnly: false,
  withShortage: false,
  withAvailable: false
};

const ROLE_OPTIONS: OpportunitySelectedRole[] = [
  "demand",
  "stock",
  "excess",
  "supplier_offer",
  "received_history",
  "purchase_history",
  "quote_history",
  "sales_history",
  "ignore"
];

const SUMMARY_KEYS: Array<keyof OpportunitySummary> = [
  "analyzedMpns",
  "exactMatches",
  "usableAvailabilityMatches",
  "exactQuantityMatches",
  "fullSales",
  "partialSales",
  "sourcingNeeded",
  "excessResales",
  "supplierOfferMatches",
  "supplyWithoutDemand",
  "historicalSignals",
  "reviewRequired",
  "missingMpnRows",
  "invalidQuantityRows",
  "possibleMatches",
  "rejectedRows",
  "demandEvents",
  "demandPartOptions",
  "supplyLots"
];

const TERMINAL_STATUSES: OpportunityJobStatus[] = [
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled"
];

const MODE_COPY = {
  es: {
    question: "¿Cómo quieres buscar?",
    singleTitle: "Buscar con 1 archivo",
    singleDescription: "Sube un archivo de necesidades, inventario, exceso u ofertas y QuikSol buscará oportunidades contra la información autorizada existente.",
    singleButton: "Usar un archivo",
    twoTitle: "Comparar 2 archivos",
    twoDescription: "Compara directamente un archivo de necesidades contra un archivo de disponibilidad.",
    twoButton: "Comparar dos archivos",
    oneFile: "Archivo para analizar",
    change: "Cambiar modo",
    lowConfidence: "QuikSol no está completamente seguro del tipo de archivo. Confirma qué contiene.",
    snapshot: "Consultando la base QuikSol autorizada…"
  },
  en: {
    question: "How do you want to search?",
    singleTitle: "Search with 1 file",
    singleDescription: "Upload a demand, inventory, excess, or offer file and QuikSol will search the authorized existing information.",
    singleButton: "Use one file",
    twoTitle: "Compare 2 files",
    twoDescription: "Directly compare a demand file against an availability file.",
    twoButton: "Compare two files",
    oneFile: "File to analyze",
    change: "Change mode",
    lowConfidence: "QuikSol is not completely sure about the file type. Confirm what it contains.",
    snapshot: "Querying the authorized QuikSol dataset…"
  },
  zh: {
    question: "您希望如何搜索？",
    singleTitle: "使用 1 个文件搜索",
    singleDescription: "上传需求、库存、过剩库存或报价文件，QuikSol 将在您有权访问的现有信息中查找机会。",
    singleButton: "使用一个文件",
    twoTitle: "比较 2 个文件",
    twoDescription: "直接比较需求文件和可用库存文件。",
    twoButton: "比较两个文件",
    oneFile: "要分析的文件",
    change: "更改模式",
    lowConfidence: "QuikSol 无法完全确定文件类型，请确认文件内容。",
    snapshot: "正在查询获授权的 QuikSol 数据…"
  }
} as const;

const configuredClientMaxFileSizeMb = Number(
  process.env.NEXT_PUBLIC_OPPORTUNITY_FINDER_MAX_FILE_SIZE_MB
);
const CLIENT_MAX_FILE_SIZE_MB = Number.isFinite(configuredClientMaxFileSizeMb) &&
  configuredClientMaxFileSizeMb > 0
  ? Math.min(configuredClientMaxFileSizeMb, 64)
  : 64;

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function profileConfidence(score: number): OpportunityConfidence {
  const normalized = score > 1 ? score / 100 : score;
  if (normalized >= 0.8) return "high";
  if (normalized >= 0.55) return "medium";
  return normalized > 0 ? "low" : "review";
}

function displayCode(value: string | null | undefined) {
  return value ? value.replaceAll("_", " ") : "—";
}

export function opportunityFileRequiresValidity(
  file: Pick<ApiFile, "warnings" | "columnMappings">,
  role: OpportunitySelectedRole | "" | null | undefined
) {
  return role === "supplier_offer" ||
    file.warnings.includes("embedded_offer_columns_mapped") ||
    file.columnMappings.some((mapping) => mapping.canonicalField.startsWith("embeddedOffer."));
}

export function futureValidityIso(value: string | null | undefined, now = Date.now()) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now
    ? new Date(timestamp).toISOString()
    : null;
}

function localFileError(file: File | null) {
  if (!file) return "EXACTLY_TWO_FILES_REQUIRED";
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if ([".xls", ".xlsm", ".xlsb", ".xlam", ".exe", ".bat", ".cmd", ".js", ".ps1"].includes(extension)) {
    return "FILE_TYPE_BLOCKED";
  }
  if (![".xlsx", ".csv"].includes(extension)) return "FILE_EXTENSION_INVALID";
  if (file.size > CLIENT_MAX_FILE_SIZE_MB * 1024 * 1024) return "FILE_TOO_LARGE";
  return null;
}

function directUpload(
  signedUrl: string,
  file: File,
  onProgress: (value: number) => void,
  signal: AbortSignal
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortUpload);
      callback();
    };
    const rejectAbort = () => finish(() => reject(
      isAbortError(signal.reason)
        ? signal.reason
        : requestAbortError("Opportunity Finder upload cancelled.")
    ));
    const abortUpload = () => {
      xhr.abort();
      rejectAbort();
    };
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", abortUpload, { once: true });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        finish(resolve);
      } else {
        finish(() => reject(new Error("UPLOAD_FAILED")));
      }
    };
    xhr.onerror = () => finish(() => reject(new Error("UPLOAD_FAILED")));
    xhr.onabort = rejectAbort;
    const formData = new FormData();
    formData.append("cacheControl", "3600");
    formData.append("", file);
    xhr.open("PUT", signedUrl);
    xhr.send(formData);
  });
}

async function readPayload<T>(response: Response) {
  const payload = await response.json().catch(() => ({})) as T & {
    errorCode?: string;
    reasonCode?: string;
    jobId?: string;
    status?: OpportunityJobStatus;
    reusedExistingJob?: boolean;
    createdAt?: string | null;
    pipelineVersion?: string | null;
  };
  if (!response.ok) {
    const error = new Error(payload.errorCode ?? "default") as OpportunityApiError;
    error.reasonCode = payload.reasonCode;
    error.jobId = payload.jobId;
    error.status = payload.status;
    error.reusedExistingJob = payload.reusedExistingJob;
    error.createdAt = payload.createdAt;
    error.pipelineVersion = payload.pipelineVersion;
    throw error;
  }
  return payload;
}

export { isAbortError };

function suggestedRole(type: OpportunityFileType): OpportunitySelectedRole | "" {
  return type === "financial" || type === "unknown" ? "" : type;
}

function FileDropzone({
  title,
  file,
  progress,
  disabled,
  onFile
}: {
  title: string;
  file: File | null;
  progress: number;
  disabled: boolean;
  onFile: (file: File | null) => void;
}) {
  const { language } = useLanguage();
  const text = opportunityFinderCopy(language);
  const inputRef = useRef<HTMLInputElement>(null);
  const error = localFileError(file);
  return (
    <section
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (!disabled) onFile(event.dataTransfer.files?.[0] ?? null);
      }}
      className={`min-w-0 rounded-xl border-2 border-dashed p-4 transition sm:p-5 ${
        file && !error ? "border-brand-300 bg-brand-50/40" : "border-slate-300 bg-white"
      }`}
    >
      <div className="flex min-h-44 flex-col items-center justify-center text-center">
        <UploadCloud className="h-9 w-9 text-brand-600" aria-hidden="true" />
        <h2 className="mt-3 text-base font-bold text-slate-950">{title}</h2>
        <p className="mt-1 text-sm text-slate-500">{text.dropPrompt}</p>
        <p className="mt-1 text-xs text-slate-400">
          {text.accepted.replace("64", String(CLIENT_MAX_FILE_SIZE_MB))}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          disabled={disabled}
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="focus-ring mt-4 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:w-auto"
        >
          {file ? text.replaceFile : text.selectFile}
        </button>
      </div>
      {file ? (
        <div className="mt-3 min-w-0 rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
            <div className="min-w-0">
              <p className="break-words text-sm font-semibold text-slate-900">{file.name}</p>
              <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
            </div>
            {error ? <CircleX className="ml-auto h-5 w-5 shrink-0 text-red-600" aria-hidden="true" /> : <Check className="ml-auto h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />}
          </div>
          {progress > 0 ? (
            <div className="mt-3">
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-right text-xs font-medium text-slate-500">{progress}%</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default function OpportunityFinder() {
  const { language, locale } = useLanguage();
  const text = opportunityFinderCopy(language);
  const modeText = MODE_COPY[language];
  const [comparisonMode, setComparisonMode] = useState<OpportunityComparisonMode | null>(null);
  const [localFiles, setLocalFiles] = useState<[File | null, File | null]>([null, null]);
  const [uploadProgress, setUploadProgress] = useState<[number, number]>([0, 0]);
  const [clientContext, setClientContext] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [data, setData] = useState<JobResponse | null>(null);
  const [roles, setRoles] = useState<Record<string, OpportunitySelectedRole | "">>({});
  const [validThroughByFile, setValidThroughByFile] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [compatibilityReason, setCompatibilityReason] = useState("");
  const [reusedComparison, setReusedComparison] = useState<ReusedComparison | null>(null);
  const [reviewingIds, setReviewingIds] = useState<Set<string>>(new Set());
  const [reviewNotice, setReviewNotice] = useState("");
  const [supplementalLoaded, setSupplementalLoaded] = useState({ possible: false, rejected: false });
  const [supplementalLoading, setSupplementalLoading] = useState<"possible" | "rejected" | null>(null);
  const snapshotRequestRef = useRef<string | null>(null);
  const uploadRequestRef = useRef<AbortController | null>(null);

  function errorMessage(code: string) {
    const errors = text.errors as Record<string, string>;
    return errors[code] ?? errors.default;
  }

  function resultQuery(nextFilters: FilterState, offset = 0) {
    const params = new URLSearchParams({ limit: "48", offset: String(offset), includeSupplemental: "false" });
    if (nextFilters.q.trim()) params.set("q", nextFilters.q.trim());
    if (nextFilters.manufacturer.trim()) params.set("manufacturer", nextFilters.manufacturer.trim());
    if (nextFilters.context.trim()) params.set("context", nextFilters.context.trim());
    if (nextFilters.opportunityType) params.set("type", nextFilters.opportunityType);
    if (nextFilters.fileId) params.set("fileId", nextFilters.fileId);
    if (nextFilters.exactOnly) params.set("exactOnly", "true");
    if (nextFilters.withShortage) params.set("withShortage", "true");
    if (nextFilters.withAvailable) params.set("withAvailable", "true");
    return params.toString();
  }

  async function loadJob(
    nextFilters = appliedFilters,
    offset = 0,
    append = false,
    preserveLoaded = false,
    targetJobId = jobId,
    signal?: AbortSignal
  ) {
    if (!targetJobId) return;
    const response = await fetch(`/api/opportunity-finder/jobs/${targetJobId}?${resultQuery(nextFilters, offset)}`, {
      cache: "no-store",
      signal
    });
    const payload = await readPayload<JobResponse>(response);
    const normalized: JobResponse = {
      ...payload,
      results: payload.results ?? [],
      possibleMatches: payload.possibleMatches ?? [],
      rejectedRows: payload.rejectedRows ?? [],
      capabilities: payload.capabilities ?? { canViewPricing: false, canViewFinancials: false }
    };
    setData((current) => {
      if (!current || (!append && !preserveLoaded)) return normalized;
      const candidates = append
        ? [...current.results, ...normalized.results]
        : [...normalized.results, ...current.results];
      const seen = new Set<string>();
      const results = candidates.filter((result, index) => {
        const key = result.id ?? `${result.opportunityType}:${result.normalizedMpn}:${index}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const sameJob = current.job.id === normalized.job.id;
      return {
        ...normalized,
        results,
        possibleMatches: sameJob ? current.possibleMatches : normalized.possibleMatches,
        rejectedRows: sameJob ? current.rejectedRows : normalized.rejectedRows
      };
    });
    if (payload.job.errorCode) setErrorCode(payload.job.errorCode);
  }

  async function loadSupplemental(kind: "possible" | "rejected") {
    if (!jobId || supplementalLoading) return;
    setSupplementalLoading(kind);
    try {
      const endpoint = kind === "possible" ? "possible-matches" : "rejected-rows";
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/${endpoint}?limit=100`, { cache: "no-store" });
      const payload = await readPayload<{
        possibleMatches?: JobResponse["possibleMatches"];
        rejectedRows?: JobResponse["rejectedRows"];
      }>(response);
      setData((current) => current ? {
        ...current,
        possibleMatches: kind === "possible" ? payload.possibleMatches ?? [] : current.possibleMatches,
        rejectedRows: kind === "rejected" ? payload.rejectedRows ?? [] : current.rejectedRows
      } : current);
      setSupplementalLoaded((current) => ({ ...current, [kind]: true }));
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "default");
    } finally {
      setSupplementalLoading(null);
    }
  }

  useEffect(() => {
    setSupplementalLoaded({ possible: false, rejected: false });
    setSupplementalLoading(null);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    const controller = new AbortController();
    void loadJob(appliedFilters, 0, false, false, jobId, controller.signal).catch((error) => {
      if (!isExpectedAbort(error, controller.signal)) {
        setErrorCode(error instanceof Error ? error.message : "default");
      }
    });
    return () => abortRequest(controller, "Opportunity Finder job load superseded.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, appliedFilters]);

  const shouldPoll = Boolean(jobId && (!data || !TERMINAL_STATUSES.includes(data.job.status)));

  useEffect(() => {
    if (!jobId || !shouldPoll) return;
    let stopped = false;
    let timer: number | null = null;
    let failures = 0;
    let inFlight = false;
    const controller = new AbortController();

    const schedule = (delay: number) => {
      if (stopped) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState === "hidden") {
        schedule(5000);
        return;
      }
      inFlight = true;
      try {
        const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/status`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("status_poll_failed");
        const status = await response.json() as Partial<ApiJob> & { updatedAt?: string | null };
        failures = 0;
        setData((current) => current ? { ...current, job: { ...current.job, ...status } } : current);
        if (status.status && TERMINAL_STATUSES.includes(status.status)) {
          if (status.status === "completed" || status.status === "completed_with_warnings") {
            await loadJob(appliedFilters, 0, false, true);
          }
          return;
        }
        schedule(2500);
      } catch (error) {
        if (isExpectedAbort(error, controller.signal)) return;
        failures += 1;
        setErrorCode(error instanceof Error ? error.message : "status_poll_failed");
        schedule(Math.min(2500 * 2 ** failures, 15000));
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !inFlight) {
        schedule(0);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(2500);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      abortRequest(controller, "Opportunity Finder polling stopped.");
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, shouldPoll, appliedFilters]);

  useEffect(() => () => {
    abortRequest(uploadRequestRef.current, "Opportunity Finder was closed.");
    uploadRequestRef.current = null;
  }, []);

  useEffect(() => {
    if (data?.job.status !== "awaiting_roles") return;
    setRoles((current) => {
      const next = { ...current };
      for (const file of data.files.filter((item) => item.sourceKind !== "platform_snapshot")) {
        if (next[file.id] === undefined) next[file.id] = file.selectedRole ?? suggestedRole(file.detectedType);
      }
      return next;
    });
  }, [data?.job.status, data?.files]);

  useEffect(() => {
    if (
      !jobId
      || data?.job.comparisonMode !== "single_file"
      || data.job.status !== "awaiting_roles"
      || data.job.snapshotStatus !== "pending"
      || data.job.currentStage !== "finding_matches"
      || snapshotRequestRef.current === jobId
    ) return;
    snapshotRequestRef.current = jobId;
    void (async () => {
      try {
        const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/snapshot`, { method: "POST" });
        const payload = await readPayload<{ jobId: string }>(response);
        if (payload.jobId !== jobId) setJobId(payload.jobId);
        await loadJob(appliedFilters, 0, false, false, payload.jobId);
      } catch (error) {
        const apiError = error as OpportunityApiError;
        if (apiError.jobId) setJobId(apiError.jobId);
        setErrorCode(apiError.message || "DATASET_SNAPSHOT_FAILED");
        snapshotRequestRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, data?.job.status, data?.job.currentStage, data?.job.snapshotStatus, data?.job.comparisonMode]);

  const roleCompatibility = useMemo(() => {
    const uploadedFiles = data?.files.filter((file) => file.sourceKind !== "platform_snapshot") ?? [];
    const fileA = uploadedFiles.find((file) => file.side === "A");
    const fileB = uploadedFiles.find((file) => file.side === "B");
    if (data?.job.comparisonMode === "single_file" && fileA) {
      const role = roles[fileA.id] || null;
      return {
        compatible: Boolean(role && role !== "ignore" && fileA.detectedType !== "financial"),
        reasonCode: fileA.detectedType === "financial" ? "financial_file" as const : role ? "compatible" as const : "unknown_role" as const
      };
    }
    if (!fileA || !fileB) return null;
    if (fileA.detectedType === "financial" || fileB.detectedType === "financial") {
      return { compatible: false, reasonCode: "financial_file" as const };
    }
    return evaluateOpportunityCompatibility(roles[fileA.id] || null, roles[fileB.id] || null);
  }, [data?.files, data?.job.comparisonMode, roles]);

  const offerValidityMissing = useMemo(() => (
    data?.files.filter((file) => file.sourceKind !== "platform_snapshot").some((file) =>
      opportunityFileRequiresValidity(file, roles[file.id]) &&
      !futureValidityIso(validThroughByFile[file.id])
    ) ?? false
  ), [data?.files, roles, validThroughByFile]);

  const activeStep = useMemo(() => {
    if (!data) return 0;
    if (
      (data.job.status === "awaiting_roles" && data.job.currentStage === "confirming_roles") ||
      ["uploading", "inspecting_sheets", "detecting_headers", "confirming_roles"].includes(data.job.currentStage)
    ) return 1;
    if (["completed", "completed_with_warnings"].includes(data.job.status)) return 3;
    return 2;
  }, [data]);

  async function uploadAndProfile() {
    if (!comparisonMode) return;
    const selectedFiles = comparisonMode === "single_file" ? [localFiles[0]] : localFiles;
    const errors = selectedFiles.map(localFileError);
    if (errors.some(Boolean)) {
      setErrorCode(errors.find(Boolean) ?? "EXACTLY_TWO_FILES_REQUIRED");
      return;
    }
    setLoading(true);
    setErrorCode("");
    setUploadProgress([0, 0]);
    abortRequest(uploadRequestRef.current, "A newer Opportunity Finder upload started.");
    const requestController = new AbortController();
    uploadRequestRef.current = requestController;
    try {
      const contentHashes = await Promise.all(selectedFiles.map((file) => sha256OpportunityFileContents(file!)));
      throwIfRequestAborted(requestController.signal);
      const initiateResponse = await fetch("/api/opportunity-finder/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body: JSON.stringify({
          comparisonMode,
          files: selectedFiles.map((file, index) => ({
            side: index === 0 ? "A" : "B",
            fileName: file!.name,
            fileSize: file!.size,
            fileType: file!.type || null,
            contentSha256: contentHashes[index]
          })),
          clientContext: clientContext.trim() || undefined
        })
      });
      const initiate = await readPayload<{ jobId: string; files: SignedFile[] }>(initiateResponse);
      setReusedComparison(null);
      setJobId(initiate.jobId);
      await Promise.all(initiate.files.map((signed) => {
        const index = signed.side === "A" ? 0 : 1;
        return directUpload(signed.signedUrl, localFiles[index]!, (progress) => {
          setUploadProgress((current) => {
            const next: [number, number] = [...current];
            next[index] = progress;
            return next;
          });
        }, requestController.signal);
      }));
      const profileResponse = await fetch(`/api/opportunity-finder/jobs/${initiate.jobId}/profile`, {
        method: "POST",
        signal: requestController.signal
      });
      await readPayload(profileResponse);
      await loadJob(appliedFilters, 0, false, false, initiate.jobId, requestController.signal);
    } catch (error) {
      if (isExpectedAbort(error, requestController.signal)) return;
      const apiError = error as OpportunityApiError;
      if (apiError.reusedExistingJob && apiError.jobId && apiError.status) {
        setReusedComparison({
          jobId: apiError.jobId,
          status: apiError.status,
          createdAt: apiError.createdAt ?? null,
          pipelineVersion: apiError.pipelineVersion ?? null
        });
        setJobId(apiError.jobId);
        setErrorCode("");
        return;
      }
      if (apiError.jobId) setJobId(apiError.jobId);
      setErrorCode(apiError.message || "default");
    } finally {
      if (uploadRequestRef.current === requestController) uploadRequestRef.current = null;
      setLoading(false);
    }
  }

  async function confirmRoles() {
    if (!jobId || !data || !roleCompatibility?.compatible) {
      setCompatibilityReason(roleCompatibility?.reasonCode ?? "unknown_role");
      return;
    }
    if (offerValidityMissing) {
      setErrorCode("OFFER_VALIDITY_REQUIRED");
      return;
    }
    setLoading(true);
    setErrorCode("");
    try {
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: data.files.filter((file) => file.sourceKind !== "platform_snapshot").map((file) => ({
            id: file.id,
            role: roles[file.id],
            validThrough: opportunityFileRequiresValidity(file, roles[file.id])
              ? futureValidityIso(validThroughByFile[file.id])
              : null
          }))
        })
      });
      await readPayload(response);
      setCompatibilityReason("");
      await loadJob();
    } catch (error) {
      const apiError = error as Error & { reasonCode?: string };
      setErrorCode(apiError.message);
      setCompatibilityReason(apiError.reasonCode ?? "");
    } finally {
      setLoading(false);
    }
  }

  async function cancelJob() {
    if (!jobId) return;
    abortRequest(uploadRequestRef.current, "Opportunity Finder cancelled by the user.");
    uploadRequestRef.current = null;
    try {
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/cancel`, { method: "POST" });
      await readPayload(response);
      await loadJob();
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "default");
    }
  }

  async function retryJob() {
    if (!jobId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/retry`, { method: "POST" });
      await readPayload(response);
      setErrorCode("");
      await loadJob();
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "default");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    abortRequest(uploadRequestRef.current, "A new Opportunity Finder search was started.");
    uploadRequestRef.current = null;
    setLoading(false);
    setComparisonMode(null);
    setLocalFiles([null, null]);
    setUploadProgress([0, 0]);
    setClientContext("");
    setJobId(null);
    setData(null);
    setRoles({});
    setValidThroughByFile({});
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setErrorCode("");
    setCompatibilityReason("");
    setReusedComparison(null);
    setReviewingIds(new Set());
    setReviewNotice("");
    setSupplementalLoaded({ possible: false, rejected: false });
    setSupplementalLoading(null);
    snapshotRequestRef.current = null;
  }

  async function deleteJob() {
    if (!jobId || !window.confirm(text.deleteJob)) return;
    const response = await fetch(`/api/opportunity-finder/jobs/${jobId}`, { method: "DELETE" });
    if (response.ok) reset();
    else {
      const payload = await response.json().catch(() => ({}));
      setErrorCode(payload.errorCode ?? "default");
    }
  }

  function swapRoles() {
    const fileA = data?.files.find((file) => file.side === "A");
    const fileB = data?.files.find((file) => file.side === "B");
    if (!fileA || !fileB) return;
    setRoles((current) => ({
      ...current,
      [fileA.id]: current[fileB.id] ?? "",
      [fileB.id]: current[fileA.id] ?? ""
    }));
  }

  function applyFilters() {
    setAppliedFilters({ ...filters });
  }

  async function decideReview(
    entityType: "result" | "possible_match",
    entityId: string,
    decision: "approved" | "rejected"
  ) {
    if (!jobId) return;
    setReviewNotice("");
    setReviewingIds((current) => new Set(current).add(entityId));
    try {
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, decision })
      });
      const payload = await readPayload<{ reviewStatus: "approved" | "rejected" }>(response);
      setData((current) => {
        if (!current) return current;
        if (entityType === "result") {
          return {
            ...current,
            results: current.results.map((result) => result.id === entityId
              ? { ...result, reviewStatus: payload.reviewStatus }
              : result)
          };
        }
        return {
          ...current,
          possibleMatches: current.possibleMatches.map((match) => match.id === entityId
            ? { ...match, reviewStatus: payload.reviewStatus }
            : match)
        };
      });
      setReviewNotice(text.review.saved);
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : "default");
      setReviewNotice(text.review.failed);
    } finally {
      setReviewingIds((current) => {
        const next = new Set(current);
        next.delete(entityId);
        return next;
      });
    }
  }

  const currentCompatibilityReason = compatibilityReason || (!roleCompatibility?.compatible ? roleCompatibility?.reasonCode : "");
  const summary = data?.job.summary ?? {};
  const resultGroups = data ? [
    { key: "full", title: text.categories.full, results: data.results.filter((result) => result.opportunityType === "full_sale") },
    { key: "partial", title: text.categories.partial, results: data.results.filter((result) => result.opportunityType === "partial_sale") },
    { key: "sourcing", title: text.categories.sourcing, results: data.results.filter((result) => result.opportunityType === "sourcing_needed") },
    { key: "supplyOnly", title: text.categories.supplyOnly, results: data.results.filter((result) => result.opportunityType === "supply_without_demand") },
    {
      key: "other",
      title: text.categories.other,
      results: data.results.filter((result) => !["full_sale", "partial_sale", "sourcing_needed", "supply_without_demand"].includes(result.opportunityType))
    }
  ] : [];

  return (
    <div className="min-w-0 space-y-6 overflow-x-hidden">
      <header>
        <p className="text-sm font-semibold text-brand-700">{text.eyebrow}</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">{text.title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{text.description}</p>
      </header>

      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {text.steps.map((step, index) => (
          <li key={step} className={`flex min-h-12 items-center gap-2 rounded-lg border px-3 text-sm font-semibold ${
            index === activeStep ? "border-brand-300 bg-brand-50 text-brand-800" : index < activeStep ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-500"
          }`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              index <= activeStep ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500"
            }`}>{index < activeStep ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}</span>
            <span className="leading-tight">{step}</span>
          </li>
        ))}
      </ol>

      {errorCode ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          {errorMessage(errorCode)}
        </div>
      ) : null}

      {reusedComparison ? (
        <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
          <p className="font-semibold">{text.reusedComparisonNotice}</p>
          <p className="mt-1 text-blue-800">
            {text.reusedComparisonStatus}:{" "}
            <span className="font-semibold">
              {STATUS_LABELS[language][data?.job.status ?? reusedComparison.status]}
            </span>
          </p>
        </div>
      ) : null}

      {!jobId ? (
        <section className="space-y-4">
          {!comparisonMode ? (
            <div>
              <h2 className="text-lg font-bold text-slate-950">{modeText.question}</h2>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <article className="flex flex-col rounded-2xl border-2 border-brand-200 bg-white p-6 shadow-sm">
                  <FileSpreadsheet className="h-9 w-9 text-brand-600" aria-hidden="true" />
                  <h3 className="mt-4 text-xl font-bold text-slate-950">{modeText.singleTitle}</h3>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{modeText.singleDescription}</p>
                  <button type="button" onClick={() => setComparisonMode("single_file")} className="focus-ring mt-5 min-h-12 rounded-lg bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700">
                    {modeText.singleButton}
                  </button>
                </article>
                <article className="flex flex-col rounded-2xl border-2 border-slate-200 bg-white p-6 shadow-sm">
                  <ArrowLeftRight className="h-9 w-9 text-brand-600" aria-hidden="true" />
                  <h3 className="mt-4 text-xl font-bold text-slate-950">{modeText.twoTitle}</h3>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{modeText.twoDescription}</p>
                  <button type="button" onClick={() => setComparisonMode("two_files")} className="focus-ring mt-5 min-h-12 rounded-lg border border-brand-300 px-5 text-sm font-bold text-brand-700 hover:bg-brand-50">
                    {modeText.twoButton}
                  </button>
                </article>
              </div>
            </div>
          ) : (
            <>
              <div className={`grid gap-4 ${comparisonMode === "two_files" ? "md:grid-cols-2" : "max-w-2xl"}`}>
                <FileDropzone
                  title={comparisonMode === "single_file" ? modeText.oneFile : text.needsFile}
                  file={localFiles[0]}
                  progress={uploadProgress[0]}
                  disabled={loading}
                  onFile={(file) => setLocalFiles((current) => [file, current[1]])}
                />
                {comparisonMode === "two_files" ? (
                  <FileDropzone
                    title={text.supplyFile}
                    file={localFiles[1]}
                    progress={uploadProgress[1]}
                    disabled={loading}
                    onFile={(file) => setLocalFiles((current) => [current[0], file])}
                  />
                ) : null}
              </div>
              <button type="button" disabled={loading} onClick={() => {
                setComparisonMode(null);
                setLocalFiles([null, null]);
                setUploadProgress([0, 0]);
              }} className="focus-ring min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                {modeText.change}
              </button>
            </>
          )}
          {comparisonMode ? (
          <>
          <div className="max-w-2xl rounded-xl border border-slate-200 bg-white p-4">
            <label htmlFor="opportunity-client-context" className="block text-sm font-semibold text-slate-800">
              {text.clientContext}
            </label>
            <input
              id="opportunity-client-context"
              value={clientContext}
              maxLength={160}
              disabled={loading}
              onChange={(event) => setClientContext(event.target.value)}
              placeholder={text.clientContextPlaceholder}
              className="focus-ring mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-950"
            />
            <p className="mt-1 text-xs leading-5 text-slate-500">{text.clientContextHelp}</p>
          </div>
          <button
            type="button"
            disabled={loading || !localFiles[0] || (comparisonMode === "two_files" && !localFiles[1])}
            onClick={() => void uploadAndProfile()}
            className="focus-ring inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {loading ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : <UploadCloud className="h-5 w-5" aria-hidden="true" />}
            {loading ? text.uploading : text.uploadFiles}
          </button>
          </>
          ) : null}
        </section>
      ) : null}

      {data?.job.status === "awaiting_roles" && data.job.currentStage === "confirming_roles" ? (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="grid gap-4 md:grid-cols-2">
            {data.files.filter((file) => file.sourceKind !== "platform_snapshot").map((file) => (
              <div key={file.id} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="break-words text-base font-bold text-slate-950">{file.originalFileName}</p>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm lg:grid-cols-3">
                  <div><dt className="text-xs font-semibold text-slate-500">{text.detectedType}</dt><dd className="mt-1 font-medium text-slate-900">{FILE_TYPE_LABELS[language][file.detectedType]}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.sheets}</dt><dd className="mt-1 font-medium text-slate-900">{file.sheetCount}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.rows}</dt><dd className="mt-1 font-medium text-slate-900">{new Intl.NumberFormat(locale).format(file.rowCount)}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.usefulSheets}</dt><dd className="mt-1 font-medium text-slate-900">{(file.sheets ?? []).filter((sheet) => Number(sheet.usefulRowCount ?? sheet.rowCount) > 0).length}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.usefulRows}</dt><dd className="mt-1 font-medium text-slate-900">{new Intl.NumberFormat(locale).format(file.usefulRowCount ?? file.rowCount)}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.hiddenRows}</dt><dd className="mt-1 font-medium text-slate-900">{new Intl.NumberFormat(locale).format(file.hiddenRowCount ?? 0)}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.template}</dt><dd className="mt-1 break-words font-medium capitalize text-slate-900">{displayCode(file.templateType)}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.mappingVersion}</dt><dd className="mt-1 break-words font-medium text-slate-900">{file.mappingVersion ?? "—"}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.profile.confidence}</dt><dd className="mt-1 font-medium capitalize text-slate-900">{profileConfidence(file.classificationScore)} · {file.classificationScore > 1 ? Math.round(file.classificationScore) : Math.round(file.classificationScore * 100)}%</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.validation}</dt><dd className="mt-1 inline-flex items-center gap-1 font-medium text-emerald-700"><Check className="h-4 w-4" />{text.valid}</dd></div>
                </dl>
                {file.classificationReasons?.length ? (
                  <div className="mt-4">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.profile.reasons}</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-700">
                      {file.classificationReasons.map((reason, index) => <li key={`${reason}-${index}`} className="break-words">{displayCode(reason)}</li>)}
                    </ul>
                  </div>
                ) : null}
                {profileConfidence(file.classificationScore) === "low" || profileConfidence(file.classificationScore) === "review" ? (
                  <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">{modeText.lowConfidence}</p>
                ) : null}
                {file.warnings?.length || file.errors?.length ? (
                  <div className="mt-4 space-y-2" role={file.errors?.length ? "alert" : "status"}>
                    {file.warnings?.length ? <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"><span className="font-bold">{text.profile.warnings}:</span> {file.warnings.map(displayCode).join(" · ")}</p> : null}
                    {file.errors?.length ? <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900"><span className="font-bold">{text.profile.errors}:</span> {file.errors.map(displayCode).join(" · ")}</p> : null}
                  </div>
                ) : null}
                <div className="mt-4 space-y-2">
                  {(file.sheets ?? []).map((sheet) => {
                    const mappings = sheet.headerRows?.flatMap((header) => header.columnMappings ?? []) ?? [];
                    const previewRows = sheet.previewRows ?? [];
                    const previewHeaders = Array.from(new Set(previewRows.flatMap((row) => Object.keys(row.values)))).slice(0, 6);
                    return (
                      <details key={sheet.sheetName} className="rounded-lg border border-slate-200 bg-white p-3">
                        <summary className="focus-ring cursor-pointer rounded text-sm font-semibold text-slate-900">
                          {sheet.sheetName} · {new Intl.NumberFormat(locale).format(sheet.usefulRowCount ?? sheet.rowCount)} {text.profile.usefulRows.toLowerCase()}
                        </summary>
                        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                          <div><dt className="font-semibold text-slate-500">{text.profile.visibleRows}</dt><dd className="mt-0.5 text-slate-900">{Math.max(0, (sheet.usefulRowCount ?? sheet.rowCount ?? 0) - (sheet.hiddenRowCount ?? 0))}</dd></div>
                          <div><dt className="font-semibold text-slate-500">{text.profile.hiddenRows}</dt><dd className="mt-0.5 text-slate-900">{sheet.hiddenRowCount ?? 0}</dd></div>
                          <div className="col-span-2"><dt className="font-semibold text-slate-500">{text.profile.headerRow}</dt><dd className="mt-0.5 break-words text-slate-900">{(sheet.headerRows ?? []).map((header) => `${header.rowNumber}: ${header.headers.join(" · ")}`).join(" | ") || "—"}</dd></div>
                        </dl>
                        <div className="mt-3">
                          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.profile.mappings}</p>
                          {(mappings.length ? mappings : file.columnMappings ?? []).length ? (
                            <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                              {(mappings.length ? mappings : file.columnMappings ?? []).map((mapping, index) => (
                                <li key={`${mapping.canonicalField}-${mapping.sourceColumn}-${index}`} className="break-words rounded bg-slate-50 px-2 py-1.5 text-slate-700">
                                  <span className="font-semibold">{mapping.canonicalField}</span> ← {mapping.sourceHeader} ({mapping.sourceColumn}) · {mapping.confidence}
                                </li>
                              ))}
                            </ul>
                          ) : <p className="mt-1 text-xs text-slate-500">{text.profile.noMappings}</p>}
                        </div>
                        {previewRows.length ? (
                          <div className="mt-3">
                            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{text.profile.preview}</p>
                            <div className="mt-2 overflow-x-auto rounded border border-slate-200">
                              <table className="min-w-full text-left text-xs">
                                <thead className="bg-slate-50 text-slate-600"><tr><th className="px-2 py-1.5">#</th>{previewHeaders.map((header) => <th key={header} className="whitespace-nowrap px-2 py-1.5">{header}</th>)}</tr></thead>
                                <tbody className="divide-y divide-slate-100">
                                  {previewRows.slice(0, 5).map((row) => <tr key={row.rowNumber}><td className="whitespace-nowrap px-2 py-1.5 font-semibold">{row.rowNumber}{row.hidden ? "*" : ""}</td>{previewHeaders.map((header) => <td key={header} className="max-w-48 break-words px-2 py-1.5 text-slate-700">{row.values[header] ?? ""}</td>)}</tr>)}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : null}
                        {sheet.warnings?.length ? <p className="mt-3 text-xs text-amber-800"><span className="font-bold">{text.profile.warnings}:</span> {sheet.warnings.map(displayCode).join(" · ")}</p> : null}
                        {sheet.errors?.length ? <p className="mt-2 text-xs text-red-800"><span className="font-bold">{text.profile.errors}:</span> {sheet.errors.map(displayCode).join(" · ")}</p> : null}
                      </details>
                    );
                  })}
                </div>
                <label className="mt-4 grid gap-1 text-sm font-semibold text-slate-700">
                  {text.selectedRole}
                  <select
                    value={roles[file.id] ?? ""}
                    onChange={(event) => setRoles((current) => ({ ...current, [file.id]: event.target.value as OpportunitySelectedRole | "" }))}
                    className="focus-ring min-h-11 rounded-lg border border-slate-300 bg-white px-3 font-normal text-slate-950"
                  >
                    <option value="">—</option>
                    {ROLE_OPTIONS.map((role) => <option key={role} value={role}>{ROLE_LABELS[language][role]}</option>)}
                  </select>
                </label>
                {opportunityFileRequiresValidity(file, roles[file.id]) ? (
                  <label className="mt-4 grid gap-1 text-sm font-semibold text-slate-700">
                    {text.offerValidity}
                    <input
                      type="datetime-local"
                      value={validThroughByFile[file.id] ?? ""}
                      onChange={(event) => setValidThroughByFile((current) => ({
                        ...current,
                        [file.id]: event.target.value
                      }))}
                      aria-invalid={!futureValidityIso(validThroughByFile[file.id])}
                      required
                      className="focus-ring min-h-11 rounded-lg border border-slate-300 bg-white px-3 font-normal text-slate-950"
                    />
                    <span className={`text-xs font-normal ${
                      futureValidityIso(validThroughByFile[file.id]) ? "text-slate-500" : "text-amber-700"
                    }`}>
                      {futureValidityIso(validThroughByFile[file.id])
                        ? text.offerValidityHelp
                        : text.offerValidityRequired}
                    </span>
                  </label>
                ) : null}
              </div>
            ))}
          </div>
          {currentCompatibilityReason ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-bold">{text.compatibilityTitle}</p>
              <p className="mt-1">{text.compatibility[currentCompatibilityReason as keyof typeof text.compatibility] ?? text.compatibility.unsupported_pair}</p>
            </div>
          ) : null}
          <div className="grid gap-2 sm:flex sm:justify-end">
            {data.job.comparisonMode !== "single_file" ? <button type="button" onClick={swapRoles} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />{text.swapRoles}
            </button> : null}
            <button type="button" disabled={loading || !roleCompatibility?.compatible || offerValidityMissing} onClick={() => void confirmRoles()} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              <Search className="h-4 w-4" aria-hidden="true" />{text.find}
            </button>
          </div>
        </section>
      ) : null}

      {data?.job.comparisonMode === "single_file" && data.job.status === "awaiting_roles" && data.job.currentStage === "finding_matches" ? (
        <section className="rounded-xl border border-brand-200 bg-brand-50 p-5 text-brand-900" role="status">
          <div className="flex items-center gap-3">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
            <p className="font-semibold">{modeText.snapshot}</p>
          </div>
        </section>
      ) : null}

      {data && !["awaiting_roles", "completed", "completed_with_warnings"].includes(data.job.status) ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-950">{STATUS_LABELS[language][data.job.status]}</p>
              <p className="mt-1 text-sm text-slate-600">{STAGE_LABELS[language][data.job.currentStage]}</p>
            </div>
            <span className="rounded-full bg-brand-50 px-3 py-1 text-sm font-bold text-brand-700">{Math.round(data.job.progressPercent)}%</span>
          </div>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${data.job.progressPercent}%` }} />
          </div>
          <p className="mt-3 text-xs text-slate-500">{text.processingHint}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {!["failed", "cancelled"].includes(data.job.status) ? (
              <button type="button" onClick={() => void cancelJob()} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700 hover:bg-red-50">
                <CircleX className="h-4 w-4" />{text.cancel}
              </button>
            ) : (
              <button type="button" disabled={loading} onClick={() => void retryJob()} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white">
                <RotateCcw className="h-4 w-4" />{text.retry}
              </button>
            )}
            <button type="button" onClick={reset} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">
              {text.startAnother}
            </button>
          </div>
        </section>
      ) : null}

      {data && ["completed", "completed_with_warnings"].includes(data.job.status) ? (
        <div className="space-y-6">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {SUMMARY_KEYS.map((key) => (
              <div key={key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{text.summary[key]}</p>
                <p className="mt-2 text-2xl font-bold text-slate-950">{new Intl.NumberFormat(locale).format(Number(summary[key] ?? 0))}</p>
              </div>
            ))}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-bold text-slate-950">{text.filters.title}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} placeholder={text.filters.mpn} className="focus-ring min-h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm" />
              <input value={filters.manufacturer} onChange={(event) => setFilters((current) => ({ ...current, manufacturer: event.target.value }))} placeholder={text.filters.manufacturer} className="focus-ring min-h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm" />
              <input value={filters.context} onChange={(event) => setFilters((current) => ({ ...current, context: event.target.value }))} placeholder={text.filters.context} className="focus-ring min-h-11 min-w-0 rounded-lg border border-slate-300 px-3 text-sm" />
              <select value={filters.opportunityType} onChange={(event) => setFilters((current) => ({ ...current, opportunityType: event.target.value as FilterState["opportunityType"] }))} className="focus-ring min-h-11 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm">
                <option value="">{text.filters.all}</option>
                {Object.entries(OPPORTUNITY_TYPE_LABELS[language]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={filters.fileId} onChange={(event) => setFilters((current) => ({ ...current, fileId: event.target.value }))} className="focus-ring min-h-11 min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm">
                <option value="">{text.filters.file}: {text.filters.all}</option>
                {data.files.map((file) => <option key={file.id} value={file.id}>{file.originalFileName}</option>)}
              </select>
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={filters.exactOnly}
                  onChange={(event) => setFilters((current) => ({ ...current, exactOnly: event.target.checked }))}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  <span className="block font-medium">{text.filters.exactOnly}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">{text.filters.exactOnlyHelp}</span>
                </span>
              </label>
              {[
                ["withShortage", text.filters.withShortage],
                ["withAvailable", text.filters.withAvailable]
              ].map(([key, label]) => (
                <label key={key} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={filters[key as keyof FilterState] as boolean} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.checked }))} className="h-4 w-4" />
                  {label}
                </label>
              ))}
            </div>
            <div className="mt-4 grid gap-2 sm:flex">
              <button type="button" onClick={applyFilters} className="focus-ring min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-bold text-white">{text.filters.apply}</button>
              <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS); }} className="focus-ring min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">{text.filters.clear}</button>
            </div>
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold text-slate-950">{text.resultsTitle}</h2>
              <div className="grid w-full gap-2 sm:flex sm:w-auto">
                <a href={`/api/opportunity-finder/jobs/${jobId}/export?format=csv&lang=${language}`} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700"><Download className="h-4 w-4" />{text.exportCsv}</a>
                <a href={`/api/opportunity-finder/jobs/${jobId}/export?format=xlsx&lang=${language}`} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white"><Download className="h-4 w-4" />{text.exportXlsx}</a>
              </div>
            </div>
            {reviewNotice ? <p role="status" className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm font-medium text-blue-900">{reviewNotice}</p> : null}
            {data.results.length ? (
              <div className="mt-4 space-y-6">
                {resultGroups.filter((group) => group.results.length).map((group) => (
                  <section key={group.key} aria-labelledby={`opportunity-group-${group.key}`}>
                    <div className="flex items-center gap-2">
                      <h3 id={`opportunity-group-${group.key}`} className="text-base font-bold text-slate-900">{group.title}</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">{group.results.length}</span>
                    </div>
                    <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                      {group.results.map((result) => (
                        <OpportunityCard
                          key={result.id}
                          result={result}
                          jobId={jobId!}
                          canViewPricing={data.capabilities.canViewPricing}
                          canViewFinancials={data.capabilities.canViewFinancials}
                          reviewing={Boolean(result.id && reviewingIds.has(result.id))}
                          onReview={result.id ? (decision) => decideReview("result", result.id!, decision) : undefined}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{text.noResults}</div>
            )}
            {data.results.length < data.page.total ? (
              <button type="button" onClick={() => void loadJob(appliedFilters, data.results.length, true)} className="focus-ring mt-4 min-h-11 w-full rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50">{text.loadMore}</button>
            ) : null}
          </section>

          {!supplementalLoaded.possible ? (
            <button
              type="button"
              disabled={supplementalLoading !== null}
              onClick={() => void loadSupplemental("possible")}
              className="focus-ring min-h-11 w-full rounded-xl border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900 disabled:opacity-50"
            >
              {supplementalLoading === "possible" ? text.uploading : text.possibleTitle}
            </button>
          ) : data.possibleMatches.length ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
              <h2 className="font-bold text-amber-950">{text.possibleTitle}</h2>
              <p className="mt-1 text-sm text-amber-800">{text.possibleDescription}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.possibleMatches.map((match) => (
                  <div key={match.id} className="rounded-lg border border-amber-200 bg-white p-3 text-sm text-slate-700">
                    <p><span className="font-bold">{match.demandDisplayMpn}</span><span className="mx-2 text-amber-600">↔</span><span className="font-bold">{match.supplyDisplayMpn}</span></p>
                    <p className="mt-1 text-xs capitalize text-slate-500">{displayCode(match.matchTier)} · {displayCode(match.confidence)} · {displayCode(match.reviewStatus ?? "pending")}</p>
                    {match.explanation ? <p className="mt-2 text-xs leading-5 text-slate-600">{match.explanation}</p> : null}
                    {match.demandTrace || match.supplyTrace ? (
                      <div className="mt-2 space-y-1 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                        {match.demandTrace ? (
                          <p><span className="font-semibold text-slate-700">{text.card.demandSource}:</span> {[match.demandTrace.fileName, match.demandTrace.sheetName, `${text.card.row} ${match.demandTrace.sourceRow}`].filter(Boolean).join(" · ")}</p>
                        ) : null}
                        {match.supplyTrace ? (
                          <p><span className="font-semibold text-slate-700">{text.card.supplySource}:</span> {[match.supplyTrace.fileName, match.supplyTrace.sheetName, `${text.card.row} ${match.supplyTrace.sourceRow}`].filter(Boolean).join(" · ")}</p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-2" aria-label={text.review.title}>
                      <button type="button" disabled={reviewingIds.has(match.id)} onClick={() => void decideReview("possible_match", match.id, "approved")} className="focus-ring inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-emerald-300 px-2 text-xs font-semibold text-emerald-800 disabled:opacity-50"><Check className="h-3.5 w-3.5" aria-hidden="true" />{text.review.approve}</button>
                      <button type="button" disabled={reviewingIds.has(match.id)} onClick={() => void decideReview("possible_match", match.id, "rejected")} className="focus-ring inline-flex min-h-10 items-center justify-center gap-1 rounded-md border border-red-300 px-2 text-xs font-semibold text-red-800 disabled:opacity-50"><CircleX className="h-3.5 w-3.5" aria-hidden="true" />{text.review.reject}</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{text.noResults}</p>
          )}

          {!supplementalLoaded.rejected ? (
            <button
              type="button"
              disabled={supplementalLoading !== null}
              onClick={() => void loadSupplemental("rejected")}
              className="focus-ring min-h-11 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 disabled:opacity-50"
            >
              {supplementalLoading === "rejected" ? text.uploading : text.rejectedTitle}
            </button>
          ) : (
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <h2 className="font-bold text-slate-950">{text.rejectedTitle}</h2>
            <p className="mt-1 text-sm text-slate-600">{text.rejectedDescription}</p>
            {data.rejectedRows.length ? (
              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr><th className="px-3 py-2">{text.filters.file}</th><th className="px-3 py-2">{text.sheets}</th><th className="px-3 py-2">{text.card.row}</th><th className="px-3 py-2">{text.card.reason}</th><th className="px-3 py-2">{text.profile.source}</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.rejectedRows.map((row) => (
                      <tr key={row.id}>
                        <td className="max-w-56 break-words px-3 py-2 font-medium text-slate-800">{row.fileName}</td>
                        <td className="max-w-44 break-words px-3 py-2 text-slate-700">{row.sheetName}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700">{row.sourceRow}{row.hidden ? "*" : ""}</td>
                        <td className="max-w-56 break-words px-3 py-2 text-slate-700">{displayCode(row.reasonCode)}</td>
                        <td className="max-w-56 break-words px-3 py-2 text-slate-600">{[row.sourceColumn, row.fieldName, row.safeRawValue].filter(Boolean).join(" · ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="mt-3 text-sm text-slate-500">{text.noRejectedRows}</p>}
          </section>
          )}

          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
            <button type="button" onClick={reset} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700"><RotateCcw className="h-4 w-4" />{text.startAnother}</button>
            <button type="button" onClick={() => void deleteJob()} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700"><Trash2 className="h-4 w-4" />{text.deleteJob}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
