"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { commerceCopy } from "@/lib/commerce/ui-i18n";
import { isDemoAccountName } from "@/lib/commerce/ui-model";

export function DemoAccountBadge({
  accountName,
  className = ""
}: {
  accountName: string;
  className?: string;
}) {
  if (!isDemoAccountName(accountName)) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700 ${className}`}
      aria-label="Demo account"
    >
      DEMO
    </span>
  );
}

export function DemoAccountNotice({
  accountName,
  className = ""
}: {
  accountName: string;
  className?: string;
}) {
  const { language } = useLanguage();
  if (!isDemoAccountName(accountName)) return null;
  return (
    <p className={`rounded-md border border-indigo-100 bg-indigo-50/70 px-3 py-2 text-xs text-indigo-800 ${className}`}>
      {commerceCopy(language).demoNotice}
    </p>
  );
}
