"use client";

import { useCallback, useEffect, useState } from "react";
import ColumnMapper from "@/components/ColumnMapper";
import { useLanguage } from "@/components/LanguageProvider";
import UploadExcelCard from "@/components/UploadExcelCard";
import UploadHistory from "@/components/UploadHistory";
import type { BusinessCategory, UploadBatch } from "@/lib/types";

interface UploadResult {
  recordsUploaded: number;
  detectedCategory: string;
  dataQualityScore?: number;
}

export default function UploadPage() {
  const { t } = useLanguage();
  const [uploads, setUploads] = useState<UploadBatch[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUploads = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/upload", { cache: "no-store" });
    const payload = (await response.json()) as { uploads: UploadBatch[] };
    setUploads(payload.uploads ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">{t("upload.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t("upload.title")}</h1>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <UploadExcelCard
          onUploaded={(uploadResult) => {
            setResult({
              detectedCategory: uploadResult.detectedCategory,
              recordsUploaded: uploadResult.recordsUploaded,
              dataQualityScore: uploadResult.dataQualityScore
            });
            loadUploads();
          }}
        />
        <ColumnMapper
          detectedCategory={(result?.detectedCategory ?? "Generic") as BusinessCategory}
          recordsUploaded={result?.recordsUploaded}
        />
      </div>
      {loading ? (
        <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("upload.loadingHistory")}</div>
      ) : (
        <UploadHistory uploads={uploads} />
      )}
    </div>
  );
}
