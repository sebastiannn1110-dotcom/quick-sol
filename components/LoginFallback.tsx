"use client";

import { useLanguage } from "@/components/LanguageProvider";

export default function LoginFallback() {
  const { t } = useLanguage();

  return <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-soft" role="status">{t("login.loading")}</div>;
}
