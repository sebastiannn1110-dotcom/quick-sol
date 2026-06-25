"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import AnalyticsCards from "@/components/AnalyticsCards";
import { useLanguage } from "@/components/LanguageProvider";
import type { PlatformAnalyticsSummary } from "@/lib/types";

export default function AdminAnalyticsPage() {
  const { t } = useLanguage();
  const [analytics, setAnalytics] = useState<PlatformAnalyticsSummary | null>(null);

  useEffect(() => {
    async function loadAnalytics() {
      const response = await fetch("/api/admin/analytics", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { analytics: PlatformAnalyticsSummary };
        setAnalytics(payload.analytics);
      }
    }
    loadAnalytics();
  }, []);

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">{t("nav.admin")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.analyticsTitle")}</h1>
        </div>
        {analytics ? <AnalyticsCards analytics={analytics} /> : <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("analytics.loading")}</div>}
      </div>
    </AdminGuard>
  );
}
