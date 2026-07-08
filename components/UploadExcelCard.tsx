"use client";

import { FormEvent, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { clientLogger } from "@/lib/logger/clientLogger";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { ImportJob, UploadBatch } from "@/lib/types";

interface UploadResult {
  message: string;
  upload: UploadBatch;
  recordsUploaded: number;
  detectedCategory: string;
  dataQualityScore?: number;
}

interface UploadExcelCardProps {
  onUploaded?: (result: UploadResult) => void;
  onStatusChange?: () => void;
}

interface InitiateResponse {
  uploadId: string;
  jobId: string;
  bucket: string;
  storagePath: string;
  signedUrl: string;
  token: string;
  path: string;
  error?: string;
  message?: string;
}

interface JobResponse {
  job: ImportJob;
  upload: UploadBatch | null;
  error?: string;
}

interface ActiveJobState {
  uploadId: string;
  jobId: string;
  fileName: string;
  status: ImportJob["status"];
  uploadProgress: number;
  processingProgress: number;
  processedRows: number;
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  errorMessage: string | null;
}

class UploadApiError extends Error {
  status: number;
  code?: string;
  traceId?: string;
  payload: unknown;

  constructor(message: string, input: { status: number; code?: string; traceId?: string; payload: unknown }) {
    super(message);
    this.name = "UploadApiError";
    this.status = input.status;
    this.code = input.code;
    this.traceId = input.traceId;
    this.payload = input.payload;
  }
}

const UPLOAD_CATEGORIES = [
  "Auto Detect",
  "Quotation",
  "RFQ",
  "Supplier Offer",
  "Customer Demand",
  "Sales Margin",
  "Logistics",
  "Inventory",
  "Quality",
  "Finance",
  "Generic"
];

const INITIAL_FORM = {
  selectedCategory: "Auto Detect",
  department: "",
  region: "",
  notes: ""
};

const POLL_INTERVAL_MS = 2500;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function readJsonResponse<T>(response: Response): Promise<T & { error?: string; message?: string }> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : typeof payload?.message === "string" ? payload.message : "Request failed.";
    console.error("[upload] API request failed", {
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : undefined,
      traceId: typeof payload?.traceId === "string" ? payload.traceId : undefined,
      payload
    });
    throw new UploadApiError(message, {
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : undefined,
      traceId: typeof payload?.traceId === "string" ? payload.traceId : undefined,
      payload
    });
  }
  return payload as T & { error?: string; message?: string };
}

function userFacingUploadError(error: unknown, t: ReturnType<typeof useLanguage>["t"]) {
  if (error instanceof UploadApiError) {
    if (error.status === 401) return t("upload.error.sessionExpired");
    if (error.status === 413) return t("upload.error.fileTooLarge");
    if (error.code === "UPLOAD_ENV_ERROR") return t("upload.error.env");
    if (error.code === "UPLOAD_STORAGE_ERROR" || error.code === "UPLOAD_STORAGE_BUCKET_MISSING") return t("upload.error.storage");
    if (
      error.code === "UPLOAD_DATABASE_ERROR" ||
      error.code === "UPLOAD_MIGRATION_MISSING" ||
      error.code === "UPLOAD_RLS_BLOCKED" ||
      error.code === "SUPABASE_ERROR"
    ) {
      return t("upload.error.database");
    }
  }
  return error instanceof Error ? error.message : t("upload.failed");
}

function buildIdempotencyKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function uploadToSignedUrlWithProgress(
  signedUrl: string,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const cleanup = () => signal.removeEventListener("abort", abortUpload);
    const abortUpload = () => {
      xhr.abort();
      cleanup();
      reject(new DOMException("Upload cancelled.", "AbortError"));
    };

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(xhr.responseText || `Storage upload failed with status ${xhr.status}.`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Storage upload failed before the file reached Supabase."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled.", "AbortError"));
    };

    signal.addEventListener("abort", abortUpload, { once: true });
    const formData = new FormData();
    formData.append("cacheControl", "3600");
    formData.append("", file);
    xhr.open("PUT", signedUrl);
    xhr.send(formData);
  });
}

async function uploadDirectlyToStorage(initiate: InitiateResponse, file: File, onProgress: (progress: number) => void, signal: AbortSignal) {
  try {
    await uploadToSignedUrlWithProgress(initiate.signedUrl, file, onProgress, signal);
    return;
  } catch (error) {
    if (signal.aborted) throw error;
    clientLogger.uploadFailed({
      phase: "xhr_signed_upload",
      message: error instanceof Error ? error.message : "Signed URL upload failed"
    });
  }

  const supabase = createSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase browser client is not configured.");
  const { error } = await supabase.storage
    .from(initiate.bucket)
    .uploadToSignedUrl(initiate.path || initiate.storagePath, initiate.token, file, {
      cacheControl: "3600",
      contentType: file.type || "application/octet-stream"
    });
  if (error) throw new Error(error.message);
  onProgress(100);
}

function uploadResultFromJob(job: ImportJob, upload: UploadBatch | null): UploadResult {
  if (!upload) throw new Error("Upload batch was not returned with the import job.");
  const detectedCategory = upload?.detected_category ?? "Generic";
  return {
    message: "Records Uploaded Successfully",
    upload,
    recordsUploaded: upload?.valid_rows ?? job.successful_rows ?? 0,
    detectedCategory,
    dataQualityScore: upload?.data_quality_score ?? undefined
  };
}

export default function UploadExcelCard({ onUploaded, onStatusChange }: UploadExcelCardProps) {
  const { t, tc } = useLanguage();
  const [form, setForm] = useState(INITIAL_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeJob, setActiveJob] = useState<ActiveJobState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

  function updateField(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateActiveJob(job: ImportJob, upload: UploadBatch | null) {
    setActiveJob((current) => ({
      uploadId: job.upload_batch_id,
      jobId: job.id,
      fileName: job.original_file_name,
      status: job.status,
      uploadProgress: upload?.upload_progress_percent ?? current?.uploadProgress ?? 100,
      processingProgress: job.progress_percent ?? upload?.processing_progress_percent ?? current?.processingProgress ?? 0,
      processedRows: job.processed_rows ?? upload?.processed_rows ?? 0,
      totalRows: job.total_rows ?? upload?.total_rows ?? 0,
      successfulRows: job.successful_rows ?? upload?.successful_rows ?? upload?.valid_rows ?? 0,
      failedRows: job.failed_rows ?? upload?.failed_rows ?? upload?.invalid_rows ?? 0,
      errorMessage: job.error_message ?? upload?.error_message ?? null
    }));
  }

  async function loadJob(jobId: string) {
    const response = await fetch(`/api/upload/jobs/${jobId}`, { cache: "no-store" });
    const payload = await readJsonResponse<JobResponse>(response);
    updateActiveJob(payload.job, payload.upload);
    onStatusChange?.();
    return payload;
  }

  async function waitForJob(jobId: string) {
    while (true) {
      const payload = await loadJob(jobId);
      if (payload.job.status === "completed") return payload;
      if (payload.job.status === "failed") throw new Error(payload.job.error_message ?? t("upload.jobFailed"));
      if (payload.job.status === "cancelled") throw new DOMException(t("upload.cancelled"), "AbortError");
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError(t("upload.fileRequired"));
      return;
    }

    cancelRequestedRef.current = false;
    const abortController = new AbortController();
    abortRef.current = abortController;
    setLoading(true);
    setMessage(null);
    setError(null);

    try {
      clientLogger.uploadStarted({
        fileName: file.name,
        fileSize: file.size,
        selectedCategory: form.selectedCategory
      });

      const initiateResponse = await fetch("/api/upload/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type || null,
          selectedCategory: form.selectedCategory,
          department: form.department,
          region: form.region,
          notes: form.notes,
          idempotencyKey: buildIdempotencyKey(file)
        })
      });
      const initiate = await readJsonResponse<InitiateResponse>(initiateResponse);
      setActiveJob({
        uploadId: initiate.uploadId,
        jobId: initiate.jobId,
        fileName: file.name,
        status: "pending_upload",
        uploadProgress: 0,
        processingProgress: 0,
        processedRows: 0,
        totalRows: 0,
        successfulRows: 0,
        failedRows: 0,
        errorMessage: null
      });

      await uploadDirectlyToStorage(
        initiate,
        file,
        (uploadProgress) =>
          setActiveJob((current) => current ? { ...current, uploadProgress, status: uploadProgress >= 100 ? "uploaded" : current.status } : current),
        abortController.signal
      );

      const finalizeResponse = await fetch("/api/upload/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploadId: initiate.uploadId,
          jobId: initiate.jobId,
          uploadProgressPercent: 100
        })
      });
      await readJsonResponse(finalizeResponse);
      setMessage(t("upload.backgroundQueued"));
      onStatusChange?.();

      const completed = await waitForJob(initiate.jobId);
      const uploadResult = uploadResultFromJob(completed.job, completed.upload);
      setMessage(
        `${t("upload.jobCompleted")}. ${t("upload.qualityScore")}: ${uploadResult.dataQualityScore ?? "n/a"}`
      );
      clientLogger.uploadCompleted({
        recordsUploaded: uploadResult.recordsUploaded,
        detectedCategory: uploadResult.detectedCategory,
        dataQualityScore: uploadResult.dataQualityScore
      });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onUploaded?.(uploadResult);
    } catch (uploadError) {
      if (cancelRequestedRef.current || (uploadError instanceof DOMException && uploadError.name === "AbortError")) {
        setMessage(t("upload.cancelled"));
        setError(null);
      } else {
        const uploadMessage = userFacingUploadError(uploadError, t);
        clientLogger.uploadFailed({
          message: uploadMessage,
          technicalMessage: uploadError instanceof Error ? uploadError.message : String(uploadError)
        });
        setError(uploadMessage);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }

  async function handleCancel() {
    if (!activeJob) return;
    cancelRequestedRef.current = true;
    abortRef.current?.abort();
    setLoading(false);
    setError(null);
    try {
      await fetch(`/api/upload/jobs/${activeJob.jobId}/cancel`, { method: "POST" });
      setActiveJob((current) => current ? { ...current, status: "cancelled", errorMessage: t("upload.cancelled") } : current);
      setMessage(t("upload.cancelled"));
      onStatusChange?.();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : t("upload.failed"));
    }
  }

  async function handleRetry() {
    if (!activeJob) return;
    if (activeJob.uploadProgress < 100) {
      setError(t("upload.cannotRetryBeforeUpload"));
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/upload/jobs/${activeJob.jobId}/retry`, { method: "POST" });
      await readJsonResponse(response);
      const completed = await waitForJob(activeJob.jobId);
      const uploadResult = uploadResultFromJob(completed.job, completed.upload);
      setMessage(t("upload.jobCompleted"));
      onUploaded?.(uploadResult);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : t("upload.failed"));
    } finally {
      setLoading(false);
    }
  }

  const canCancel = Boolean(activeJob && ["pending_upload", "uploaded", "queued", "processing"].includes(activeJob.status));
  const canRetry = Boolean(activeJob && ["failed", "cancelled"].includes(activeJob.status));
  const uploadProgress = activeJob?.uploadProgress ?? 0;
  const processingProgress = activeJob?.processingProgress ?? 0;

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-950">{t("upload.cardTitle")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("upload.accepted")}</p>
      </div>
      <form onSubmit={handleSubmit} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.type")}
            <select
              required
              value={form.selectedCategory}
              onChange={(event) => updateField("selectedCategory", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-950"
            >
              {UPLOAD_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category === "Auto Detect" ? t("upload.autoDetectCategory") : tc(category)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.file")}
            <input
              ref={fileInputRef}
              required
              type="file"
              accept=".xlsx,.csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-950 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.department")}
            <input
              required
              value={form.department}
              onChange={(event) => updateField("department", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
              placeholder={t("upload.departmentPlaceholder")}
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            {t("upload.region")}
            <input
              required
              value={form.region}
              onChange={(event) => updateField("region", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
              placeholder={t("upload.regionPlaceholder")}
            />
          </label>
        </div>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          {t("upload.notes")}
          <textarea
            value={form.notes}
            onChange={(event) => updateField("notes", event.target.value)}
            className="focus-ring min-h-24 rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            placeholder={t("upload.notesPlaceholder")}
          />
        </label>

        {activeJob ? (
          <div className="rounded-md bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-semibold text-slate-800">{activeJob.fileName}</span>
              <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                {t("upload.status")}: {activeJob.status}
              </span>
            </div>
            <div className="mt-3 grid gap-3">
              <div>
                <div className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                  <span>{t("upload.uploadProgress")}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-md bg-slate-200">
                  <div className="h-full bg-brand-600 transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                  <span>{t("upload.processingProgress")}</span>
                  <span>{processingProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-md bg-slate-200">
                  <div className="h-full bg-orange-600 transition-all" style={{ width: `${processingProgress}%` }} />
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-600">
              <span>{t("upload.rowsProcessed")}: {activeJob.processedRows}</span>
              <span>{t("history.rows")}: {activeJob.totalRows}</span>
              <span>{t("history.errors")}: {activeJob.failedRows}</span>
            </div>
            {activeJob.errorMessage ? <p className="mt-2 text-xs font-medium text-red-700">{activeJob.errorMessage}</p> : null}
          </div>
        ) : null}

        {message ? (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {canRetry ? (
            <button
              disabled={loading}
              className="focus-ring rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              onClick={handleRetry}
            >
              {t("upload.retry")}
            </button>
          ) : null}
          {canCancel ? (
            <button
              className="focus-ring rounded-md border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50"
              type="button"
              onClick={handleCancel}
            >
              {t("upload.cancel")}
            </button>
          ) : null}
          <button
            disabled={loading}
            className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
          >
            {loading ? t("upload.processing") : t("upload.submit")}
          </button>
        </div>
      </form>
    </section>
  );
}
