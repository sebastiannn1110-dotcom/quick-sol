"use client";

import { useLanguage } from "@/components/LanguageProvider";

export default function LoginFallback() {
  const { t } = useLanguage();

  return <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("login.loading")}</div>;
}
