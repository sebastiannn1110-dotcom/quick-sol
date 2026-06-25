"use client";

import { useLanguage } from "@/components/LanguageProvider";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function SearchBar({
  value,
  onChange,
  placeholder
}: SearchBarProps) {
  const { t } = useLanguage();

  return (
    <div className="relative">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? t("records.searchPlaceholder")}
        className="focus-ring w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-sm placeholder:text-slate-400"
        type="search"
      />
    </div>
  );
}
