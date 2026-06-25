"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import DataTable from "@/components/DataTable";
import { useLanguage } from "@/components/LanguageProvider";
import type { PlatformRecord } from "@/lib/types";

export default function AdminRecordsPage() {
  const { t } = useLanguage();
  const [records, setRecords] = useState<PlatformRecord[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    async function loadRecords() {
      const response = await fetch("/api/admin/records?pageSize=100", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { records: PlatformRecord[]; count: number };
        setRecords(payload.records ?? []);
        setCount(payload.count ?? 0);
      }
    }
    loadRecords();
  }, []);

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
