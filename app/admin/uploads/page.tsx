"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminGuard from "@/components/AdminGuard";
import AdminUploadsTable, { type UploadWithJob } from "@/components/AdminUploadsTable";
import { useLanguage } from "@/components/LanguageProvider";

function AdminUploadsContent() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const employee = searchParams.get("employee");
  const [uploads, setUploads] = useState<UploadWithJob[]>([]);

  const loadUploads = useCallback(async () => {
    const response = await fetch(employee ? `/api/admin/uploads?employee=${employee}` : "/api/admin/uploads", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { uploads: UploadWithJob[] };
      setUploads(payload.uploads ?? []);
    }
  }, [employee]);

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">{t("nav.admin")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.uploadsTitle")}</h1>
        </div>
        <AdminUploadsTable uploads={uploads} />
      </div>
    </AdminGuard>
  );
}

export default function AdminUploadsPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading uploads...</div>}>
      <AdminUploadsContent />
    </Suspense>
  );
}
