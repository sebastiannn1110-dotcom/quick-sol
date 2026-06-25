"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LOCALES, type Language, type TranslationKey, translate, translateCategory, translateLabel } from "@/lib/i18n";

interface LanguageContextValue {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
  tc: (category: string) => string;
  tl: (label: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLanguage(): Language {
  if (typeof window === "undefined") return "es";
  const stored = window.localStorage.getItem("quiksol-language");
  return stored === "en" || stored === "zh" || stored === "es" ? stored : "es";
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("es");

  useEffect(() => {
    const storedLanguage = readStoredLanguage();
    setLanguageState(storedLanguage);
    document.documentElement.lang = storedLanguage === "zh" ? "zh-CN" : storedLanguage;
  }, []);

  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    window.localStorage.setItem("quiksol-language", nextLanguage);
    document.documentElement.lang = nextLanguage === "zh" ? "zh-CN" : nextLanguage;
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      locale: LOCALES[language],
      setLanguage,
      t: (key) => translate(key, language),
      tc: (category) => translateCategory(category, language),
      tl: (label) => translateLabel(label, language)
    }),
    [language, setLanguage]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}
