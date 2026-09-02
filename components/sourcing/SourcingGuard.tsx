"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { useProfile } from "@/components/ProfileProvider";
import { canManageSourcing } from "@/lib/sourcing/permissions";

export default function SourcingGuard({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useProfile();
  const { language } = useLanguage();
  const copy = {
    es: { loading: "Verificando permisos...", denied: "Esta área requiere business rank Sourcing Manager/Owner o el rol técnico Super Admin Dev." },
    en: { loading: "Checking permissions...", denied: "This area requires the Sourcing Manager/Owner business rank or the Super Admin Dev technical role." },
    zh: { loading: "正在检查权限...", denied: "此区域需要寻源经理/Owner 业务级别，或 Super Admin Dev 技术角色。" }
  }[language];
  if (loading) return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{copy.loading}</div>;
  if (!canManageSourcing(profile)) {
    return <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">{copy.denied}</div>;
  }
  return <>{children}</>;
}
