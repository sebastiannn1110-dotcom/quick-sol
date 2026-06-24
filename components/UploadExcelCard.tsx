"use client";

import { FormEvent, useRef, useState } from "react";
import { clientLogger } from "@/lib/logger/clientLogger";

interface UploadResult {
  message: string;
  upload: {
    id: string;
    detected_category?: string;
    detectedCategory?: string;
    data_quality_score?: number;
  };
  recordsUploaded: number;
  detectedCategory: string;
  dataQualityScore?: number;
}

interface UploadExcelCardProps {
  onUploaded?: (result: UploadResult) => void;
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

const PROGRESS_STEPS = [
  "Uploading file",
  "Reading sheets",
  "Detecting headers",
  "Normalizing rows",
  "Saving to Supabase",
  "Finished"
];

export default function UploadExcelCard({ onUploaded }: UploadExcelCardProps) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [progressStep, setProgressStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    setError(null);
    setProgressStep(0);

    const progressTimer = window.setInterval(() => {
      setProgressStep((step) => Math.min(step + 1, PROGRESS_STEPS.length - 2));
    }, 900);

    try {
      clientLogger.uploadStarted({
        fileName: file?.name,
        fileSize: file?.size,
        selectedCategory: form.selectedCategory
      });
      const payload = new FormData();
      Object.entries(form).forEach(([key, value]) => payload.append(key, value));
      if (file) payload.append("file", file);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: payload
      });
      const result = (await response.json()) as UploadResult & { error?: string };

      if (!response.ok) throw new Error(result.error ?? "Upload failed.");

      setProgressStep(PROGRESS_STEPS.length - 1);
      setMessage(
        `${result.message}. Quality score: ${result.dataQualityScore ?? result.upload.data_quality_score ?? "n/a"}`
      );
      clientLogger.uploadCompleted({
        recordsUploaded: result.recordsUploaded,
        detectedCategory: result.detectedCategory,
        dataQualityScore: result.dataQualityScore
      });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onUploaded?.(result);
    } catch (uploadError) {
      clientLogger.uploadFailed({
        message: uploadError instanceof Error ? uploadError.message : "Upload failed"
      });
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      window.clearInterval(progressTimer);
      setLoading(false);
    }
  }

  function updateField(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-950">Upload Excel File</h2>
        <p className="mt-1 text-sm text-slate-500">
          Accepted formats: .xlsx, .xls and .csv. Macros are rejected.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Upload Type
            <select
              required
              value={form.selectedCategory}
              onChange={(event) => updateField("selectedCategory", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-950"
            >
              {UPLOAD_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category === "Auto Detect" ? "Auto Detect Category" : category}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            File
            <input
              ref={fileInputRef}
              required
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-950 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Department
            <input
              required
              value={form.department}
              onChange={(event) => updateField("department", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
              placeholder="Sales"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Region
            <input
              required
              value={form.region}
              onChange={(event) => updateField("region", event.target.value)}
              className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
              placeholder="North America"
            />
          </label>
        </div>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Notes
          <textarea
            value={form.notes}
            onChange={(event) => updateField("notes", event.target.value)}
            className="focus-ring min-h-24 rounded-md border border-slate-300 px-3 py-2.5 font-normal text-slate-950"
            placeholder="Context for this upload"
          />
        </label>

        {loading ? (
          <div className="rounded-md bg-slate-50 p-3">
            <div className="flex flex-wrap gap-2">
              {PROGRESS_STEPS.map((step, index) => (
                <span
                  key={step}
                  className={`rounded-md px-2 py-1 text-xs font-medium ${
                    index <= progressStep
                      ? "bg-brand-100 text-brand-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {step}
                </span>
              ))}
            </div>
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
        <div className="flex justify-end">
          <button
            disabled={loading}
            className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
          >
            {loading ? "Processing..." : "Upload Excel File"}
          </button>
        </div>
      </form>
    </section>
  );
}
