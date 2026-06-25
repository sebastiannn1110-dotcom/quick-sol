"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminGuard from "@/components/AdminGuard";
import DataTable from "@/components/DataTable";
import { useLanguage } from "@/components/LanguageProvider";
import type { PlatformRecord } from "@/lib/types";

function AdminRecordsContent() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const uploadedBy = searchParams.get("uploadedBy");
  const [records, setRecords] = useState<PlatformRecord[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    async function loadRecords() {
      const url = uploadedBy ? `/api/admin/records?pageSize=100&uploadedBy=${uploadedBy}` : "/api/admin/records?pageSize=100";
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { records: PlatformRecord[]; count: number };
        setRecords(payload.records ?? []);
        setCount(payload.count ?? 0);
      }
    }
    loadRecords();
  }, [uploadedBy]);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">{t("nav.admin")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.recordsTitle")}</h1>
          <p className="text-sm text-slate-500">{count} {t("admin.recordsVisible")}</p>
        </div>
        <DataTable records={records} />
      </div>
    </AdminGuard>
  );
}

export default function AdminRecordsPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading records...</div>}>
      <AdminRecordsContent />
    </Suspense>
  );
}
