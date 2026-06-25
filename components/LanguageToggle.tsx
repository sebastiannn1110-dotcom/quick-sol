"use client";

import { Languages } from "lucide-react";
import { LANGUAGES } from "@/lib/i18n";
import { useLanguage } from "@/components/LanguageProvider";

export default function LanguageToggle() {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1 text-xs shadow-sm">
      <span className="sr-only">{t("language.label")}</span>
      <Languages aria-hidden="true" className="ml-1 h-4 w-4 text-slate-500" />
      {LANGUAGES.map((item) => (
        <button
          key={item.code}
          type="button"
          onClick={() => setLanguage(item.code)}
          className={`rounded px-2 py-1 font-semibold transition ${
            language === item.code ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
          aria-label={`${t("language.label")}: ${item.label}`}
          title={item.label}
        >
          {item.shortLabel}
        </button>
      ))}
    </div>
  );
}
