"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import AnalyticsCards from "@/components/AnalyticsCards";
import type { PlatformAnalyticsSummary } from "@/lib/types";

export default function AdminAnalyticsPage() {
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
          <p className="text-sm font-medium text-orange-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Global Analytics</h1>
        </div>
        {analytics ? <AnalyticsCards analytics={analytics} /> : <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading analytics...</div>}
      </div>
    </AdminGuard>
  );
}
