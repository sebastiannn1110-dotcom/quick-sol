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
import {
  FILE_TYPE_LABELS,
  OPPORTUNITY_TYPE_LABELS,
  ROLE_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  opportunityFinderCopy
} from "@/lib/opportunity-finder/i18n";
import type {
  OpportunityFileType,
  OpportunityJobStage,
  OpportunityJobStatus,
  OpportunityResult,
  OpportunitySelectedRole,
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
  sheets: Array<{ sheetName: string; rowCount: number }>;
  sheetCount: number;
  rowCount: number;
  parseStatus: string;
  storageDeletedAt: string | null;
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
  summary: Partial<OpportunitySummary>;
  errorCode: string | null;
  expiresAt: string | null;
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
  }>;
  page: { offset: number; limit: number; total: number };
};

type SignedFile = {
  id: string;
  side: "A" | "B";
  signedUrl: string;
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
  "sales_history",
  "ignore"
];

const SUMMARY_KEYS: Array<keyof OpportunitySummary> = [
  "analyzedMpns",
  "exactMatches",
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
  "possibleMatches"
];

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function localFileError(file: File | null) {
  if (!file) return "EXACTLY_TWO_FILES_REQUIRED";
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if ([".xls", ".xlsm", ".xlsb", ".xlam", ".exe", ".bat", ".cmd", ".js", ".ps1"].includes(extension)) {
    return "FILE_TYPE_BLOCKED";
  }
  if (![".xlsx", ".csv"].includes(extension)) return "FILE_EXTENSION_INVALID";
  if (file.size > 64 * 1024 * 1024) return "FILE_TOO_LARGE";
  return null;
}

function directUpload(
  signedUrl: string,
  file: File,
  onProgress: (value: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error("UPLOAD_FAILED"));
      }
    };
    xhr.onerror = () => reject(new Error("UPLOAD_FAILED"));
    const formData = new FormData();
    formData.append("cacheControl", "3600");
    formData.append("", file);
    xhr.open("PUT", signedUrl);
    xhr.send(formData);
  });
}

async function readPayload<T>(response: Response) {
  const payload = await response.json().catch(() => ({})) as T & { errorCode?: string; reasonCode?: string; jobId?: string };
  if (!response.ok) {
    const error = new Error(payload.errorCode ?? "default") as Error & { reasonCode?: string; jobId?: string };
    error.reasonCode = payload.reasonCode;
    error.jobId = payload.jobId;
    throw error;
  }
  return payload;
}

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
        <p className="mt-1 text-xs text-slate-400">{text.accepted}</p>
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
  const [localFiles, setLocalFiles] = useState<[File | null, File | null]>([null, null]);
  const [uploadProgress, setUploadProgress] = useState<[number, number]>([0, 0]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [data, setData] = useState<JobResponse | null>(null);
  const [roles, setRoles] = useState<Record<string, OpportunitySelectedRole | "">>({});
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [compatibilityReason, setCompatibilityReason] = useState("");

  function errorMessage(code: string) {
    const errors = text.errors as Record<string, string>;
    return errors[code] ?? errors.default;
  }

  function resultQuery(nextFilters: FilterState, offset = 0) {
    const params = new URLSearchParams({ limit: "48", offset: String(offset) });
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

  async function loadJob(nextFilters = appliedFilters, offset = 0, append = false) {
    if (!jobId) return;
    const response = await fetch(`/api/opportunity-finder/jobs/${jobId}?${resultQuery(nextFilters, offset)}`, { cache: "no-store" });
    const payload = await readPayload<JobResponse>(response);
    setData((current) => append && current ? {
      ...payload,
      results: [...current.results, ...payload.results]
    } : payload);
    if (payload.job.errorCode) setErrorCode(payload.job.errorCode);
  }

  useEffect(() => {
    if (!jobId) return;
    void loadJob().catch((error) => setErrorCode(error instanceof Error ? error.message : "default"));
    const timer = window.setInterval(() => {
      void loadJob().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, appliedFilters]);

  useEffect(() => {
    if (data?.job.status !== "awaiting_roles") return;
    setRoles((current) => {
      const next = { ...current };
      for (const file of data.files) {
        if (next[file.id] === undefined) next[file.id] = file.selectedRole ?? suggestedRole(file.detectedType);
      }
      return next;
    });
  }, [data?.job.status, data?.files]);

  const roleCompatibility = useMemo(() => {
    const fileA = data?.files.find((file) => file.side === "A");
    const fileB = data?.files.find((file) => file.side === "B");
    if (!fileA || !fileB) return null;
    if (fileA.detectedType === "financial" || fileB.detectedType === "financial") {
      return { compatible: false, reasonCode: "financial_file" as const };
    }
    return evaluateOpportunityCompatibility(roles[fileA.id] || null, roles[fileB.id] || null);
  }, [data?.files, roles]);

  const activeStep = useMemo(() => {
    if (!data) return 0;
    if (data.job.status === "awaiting_roles") return 1;
    if (["completed", "completed_with_warnings"].includes(data.job.status)) return 3;
    return 2;
  }, [data]);

  async function uploadAndProfile() {
    const errors = localFiles.map(localFileError);
    if (errors.some(Boolean)) {
      setErrorCode(errors.find(Boolean) ?? "EXACTLY_TWO_FILES_REQUIRED");
      return;
    }
    setLoading(true);
    setErrorCode("");
    setUploadProgress([0, 0]);
    try {
      const initiateResponse = await fetch("/api/opportunity-finder/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: localFiles.map((file, index) => ({
            side: index === 0 ? "A" : "B",
            fileName: file!.name,
            fileSize: file!.size,
            fileType: file!.type || null
          })),
          idempotencyKey: localFiles.map((file) => `${file!.name}:${file!.size}:${file!.lastModified}`).join("|")
        })
      });
      const initiate = await readPayload<{ jobId: string; files: SignedFile[] }>(initiateResponse);
      setJobId(initiate.jobId);
      await Promise.all(initiate.files.map((signed) => {
        const index = signed.side === "A" ? 0 : 1;
        return directUpload(signed.signedUrl, localFiles[index]!, (progress) => {
          setUploadProgress((current) => {
            const next: [number, number] = [...current];
            next[index] = progress;
            return next;
          });
        });
      }));
      const profileResponse = await fetch(`/api/opportunity-finder/jobs/${initiate.jobId}/profile`, { method: "POST" });
      await readPayload(profileResponse);
      await loadJob();
    } catch (error) {
      const apiError = error as Error & { jobId?: string };
      if (apiError.jobId) setJobId(apiError.jobId);
      setErrorCode(apiError.message || "default");
    } finally {
      setLoading(false);
    }
  }

  async function confirmRoles() {
    if (!jobId || !data || !roleCompatibility?.compatible) {
      setCompatibilityReason(roleCompatibility?.reasonCode ?? "unknown_role");
      return;
    }
    setLoading(true);
    setErrorCode("");
    try {
      const response = await fetch(`/api/opportunity-finder/jobs/${jobId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: data.files.map((file) => ({ id: file.id, role: roles[file.id] }))
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
    await fetch(`/api/opportunity-finder/jobs/${jobId}/cancel`, { method: "POST" });
    await loadJob();
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
    setLocalFiles([null, null]);
    setUploadProgress([0, 0]);
    setJobId(null);
    setData(null);
    setRoles({});
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setErrorCode("");
    setCompatibilityReason("");
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

  const currentCompatibilityReason = compatibilityReason || (!roleCompatibility?.compatible ? roleCompatibility?.reasonCode : "");
  const summary = data?.job.summary ?? {};

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

      {!jobId ? (
        <section className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FileDropzone
              title={text.needsFile}
              file={localFiles[0]}
              progress={uploadProgress[0]}
              disabled={loading}
              onFile={(file) => setLocalFiles((current) => [file, current[1]])}
            />
            <FileDropzone
              title={text.supplyFile}
              file={localFiles[1]}
              progress={uploadProgress[1]}
              disabled={loading}
              onFile={(file) => setLocalFiles((current) => [current[0], file])}
            />
          </div>
          <button
            type="button"
            disabled={loading || localFiles.some((file) => !file)}
            onClick={() => void uploadAndProfile()}
            className="focus-ring inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {loading ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : <UploadCloud className="h-5 w-5" aria-hidden="true" />}
            {loading ? text.uploading : text.uploadFiles}
          </button>
        </section>
      ) : null}

      {data?.job.status === "awaiting_roles" ? (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="grid gap-4 md:grid-cols-2">
            {data.files.map((file) => (
              <div key={file.id} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="break-words text-base font-bold text-slate-950">{file.originalFileName}</p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs font-semibold text-slate-500">{text.detectedType}</dt><dd className="mt-1 font-medium text-slate-900">{FILE_TYPE_LABELS[language][file.detectedType]}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.sheets}</dt><dd className="mt-1 font-medium text-slate-900">{file.sheetCount}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.rows}</dt><dd className="mt-1 font-medium text-slate-900">{new Intl.NumberFormat(locale).format(file.rowCount)}</dd></div>
                  <div><dt className="text-xs font-semibold text-slate-500">{text.validation}</dt><dd className="mt-1 inline-flex items-center gap-1 font-medium text-emerald-700"><Check className="h-4 w-4" />{text.valid}</dd></div>
                </dl>
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
            <button type="button" onClick={swapRoles} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />{text.swapRoles}
            </button>
            <button type="button" disabled={loading || !roleCompatibility?.compatible} onClick={() => void confirmRoles()} className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand-600 px-5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50">
              <Search className="h-4 w-4" aria-hidden="true" />{text.find}
            </button>
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
              {[
                ["exactOnly", text.filters.exactOnly],
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
            {data.results.length ? (
              <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {data.results.map((result) => <OpportunityCard key={result.id} result={result} jobId={jobId!} />)}
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">{text.noResults}</div>
            )}
            {data.results.length < data.page.total ? (
              <button type="button" onClick={() => void loadJob(appliedFilters, data.results.length, true)} className="focus-ring mt-4 min-h-11 w-full rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50">{text.loadMore}</button>
            ) : null}
          </section>

          {data.possibleMatches.length ? (
            <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
              <h2 className="font-bold text-amber-950">{text.possibleTitle}</h2>
              <p className="mt-1 text-sm text-amber-800">{text.possibleDescription}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.possibleMatches.map((match) => (
                  <div key={match.id} className="rounded-lg border border-amber-200 bg-white p-3 text-sm text-slate-700">
                    <span className="font-bold">{match.demandDisplayMpn}</span>
                    <span className="mx-2 text-amber-600">↔</span>
                    <span className="font-bold">{match.supplyDisplayMpn}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
            <button type="button" onClick={reset} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700"><RotateCcw className="h-4 w-4" />{text.startAnother}</button>
            <button type="button" onClick={() => void deleteJob()} className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-700"><Trash2 className="h-4 w-4" />{text.deleteJob}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
