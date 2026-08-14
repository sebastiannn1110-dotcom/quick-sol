"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { useProfile } from "@/components/ProfileProvider";
import type { UserRole } from "@/lib/types";

export default function RoleGuard({
  allowedRoles,
  children
}: {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  const { profile, loading } = useProfile();

  if (loading) {
    return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("guard.checking")}</div>;
  }

  if (!profile || !allowedRoles.includes(profile.role)) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {t("guard.denied")}
      </div>
    );
  }

  return <>{children}</>;
}
