"use client";

import Link from "next/link";
import AdminGuard from "@/components/AdminGuard";
import { useLanguage } from "@/components/LanguageProvider";
import type { TranslationKey } from "@/lib/i18n";

const ADMIN_LINKS = [
  { href: "/admin/clients", label: "clients.title", detail: "admin.links.clientsDetail" },
  { href: "/admin/users", label: "admin.links.users", detail: "admin.links.usersDetail" },
  { href: "/admin/uploads", label: "admin.links.uploads", detail: "admin.links.uploadsDetail" },
  { href: "/admin/stock-needs", label: "admin.links.stockNeeds", detail: "admin.links.stockNeedsDetail" },
  { href: "/admin/opportunities", label: "admin.links.opportunities", detail: "admin.links.opportunitiesDetail" },
  { href: "/admin/records", label: "admin.links.records", detail: "admin.links.recordsDetail" },
  { href: "/admin/search", label: "admin.links.search", detail: "admin.links.searchDetail" },
  { href: "/admin/chat-audit", label: "admin.links.chatAudit", detail: "admin.links.chatAuditDetail" },
  { href: "/admin/email-center", label: "admin.links.emailCenter", detail: "admin.links.emailCenterDetail" },
  { href: "/admin/employee-analytics", label: "admin.links.employeeAnalytics", detail: "admin.links.employeeAnalyticsDetail" },
  { href: "/admin/team-structure", label: "admin.links.teamStructure", detail: "admin.links.teamStructureDetail" }
] satisfies Array<{ href: string; label: TranslationKey; detail: TranslationKey }>;

export default function AdminPage() {
  const { t } = useLanguage();

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">{t("admin.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.title")}</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Link href="/admin/sourcing" className="rounded-md border border-slate-200 bg-white p-4 shadow-sm hover:border-orange-200 hover:bg-orange-50">
            <p className="font-semibold text-slate-950">{t("admin.links.sourcing")}</p>
            <p className="mt-1 text-sm text-slate-500">{t("admin.links.sourcingDetail")}</p>
          </Link>
          {ADMIN_LINKS.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-md border border-slate-200 bg-white p-4 shadow-sm hover:border-orange-200 hover:bg-orange-50">
              <p className="font-semibold text-slate-950">{t(item.label)}</p>
              <p className="mt-1 text-sm text-slate-500">{t(item.detail)}</p>
            </Link>
          ))}
        </div>
      </div>
    </AdminGuard>
  );
}
