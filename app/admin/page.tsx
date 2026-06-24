"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import AnalyticsCards from "@/components/AnalyticsCards";
import type { PlatformAnalyticsSummary } from "@/lib/types";

const ADMIN_LINKS = [
  { href: "/admin/users", label: "Users", detail: "Roles, departments, activation" },
  { href: "/admin/uploads", label: "All Uploads", detail: "Batch status and archive actions" },
  { href: "/admin/records", label: "All Records", detail: "Global search and traceability" },
  { href: "/admin/analytics", label: "Global Analytics", detail: "Executive metrics" },
  { href: "/admin/import-errors", label: "Import Errors", detail: "Row and column issues" },
  { href: "/admin/logs", label: "System Logs", detail: "Trace requests and backend failures" },
  { href: "/admin/performance", label: "Performance", detail: "Slow queries and measured operations" },
  { href: "/admin/audit-logs", label: "Audit Logs", detail: "Administrative actions" },
  { href: "/admin/security", label: "Security Events", detail: "Unauthorized access attempts" },
  { href: "/categories", label: "Categories", detail: "Category analytics" }
];

export default function AdminPage() {
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
          <p className="text-sm font-medium text-brand-700">Admin Dashboard</p>
          <h1 className="text-2xl font-semibold text-slate-950">Administration</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ADMIN_LINKS.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-200 hover:bg-brand-50">
              <p className="font-semibold text-slate-950">{item.label}</p>
              <p className="mt-1 text-sm text-slate-500">{item.detail}</p>
            </Link>
          ))}
        </div>
        {analytics ? <AnalyticsCards analytics={analytics} /> : null}
      </div>
    </AdminGuard>
  );
}
