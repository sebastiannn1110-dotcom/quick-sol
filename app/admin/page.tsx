"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import AnalyticsCards from "@/components/AnalyticsCards";
import { useLanguage } from "@/components/LanguageProvider";
import type { TranslationKey } from "@/lib/i18n";
import type { PlatformAnalyticsSummary } from "@/lib/types";

const ADMIN_LINKS = [
  { href: "/admin/users", label: "admin.links.users", detail: "admin.links.usersDetail" },
  { href: "/admin/uploads", label: "admin.links.uploads", detail: "admin.links.uploadsDetail" },
  { href: "/admin/stock-needs", label: "admin.links.stockNeeds", detail: "admin.links.stockNeedsDetail" },
  { href: "/admin/records", label: "admin.links.records", detail: "admin.links.recordsDetail" },
  { href: "/admin/search", label: "admin.links.search", detail: "admin.links.searchDetail" },
  { href: "/admin/analytics", label: "admin.links.analytics", detail: "admin.links.analyticsDetail" },
  { href: "/admin/traffic", label: "admin.links.traffic", detail: "admin.links.trafficDetail" },
  { href: "/admin/import-errors", label: "admin.links.importErrors", detail: "admin.links.importErrorsDetail" },
  { href: "/admin/logs", label: "admin.links.logs", detail: "admin.links.logsDetail" },
  { href: "/admin/performance", label: "admin.links.performance", detail: "admin.links.performanceDetail" },
  { href: "/admin/audit-logs", label: "admin.links.audit", detail: "admin.links.auditDetail" },
  { href: "/admin/security", label: "admin.links.security", detail: "admin.links.securityDetail" },
  { href: "/admin/chat-audit", label: "admin.links.chatAudit", detail: "admin.links.chatAuditDetail" },
  { href: "/admin/email-center", label: "admin.links.emailCenter", detail: "admin.links.emailCenterDetail" },
  { href: "/admin/email-alerts", label: "admin.links.emailAlerts", detail: "admin.links.emailAlertsDetail" },
  { href: "/categories", label: "admin.links.categories", detail: "admin.links.categoriesDetail" }
] satisfies Array<{ href: string; label: TranslationKey; detail: TranslationKey }>;

export default function AdminPage() {
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
          <p className="text-sm font-medium text-orange-700">{t("admin.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.title")}</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ADMIN_LINKS.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm hover:border-orange-200 hover:bg-orange-50">
              <p className="font-semibold text-slate-950">{t(item.label)}</p>
              <p className="mt-1 text-sm text-slate-500">{t(item.detail)}</p>
            </Link>
          ))}
        </div>
        {analytics ? <AnalyticsCards analytics={analytics} /> : null}
      </div>
    </AdminGuard>
  );
}
