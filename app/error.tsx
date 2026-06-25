"use client";

import { useEffect, useState } from "react";
import { clientLogger } from "@/lib/logger/clientLogger";
import { type Language, translate } from "@/lib/i18n";

function readLanguage(): Language {
  if (typeof window === "undefined") return "es";
  const stored = window.localStorage.getItem("quiksol-language");
  return stored === "en" || stored === "zh" || stored === "es" ? stored : "es";
}

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [language, setLanguage] = useState<Language>("es");
  const t = (key: Parameters<typeof translate>[0]) => translate(key, language);

  useEffect(() => {
    setLanguage(readLanguage());
  }, []);

  useEffect(() => {
    clientLogger.reactErrorBoundaryTriggered({
      message: error.message,
      digest: error.digest,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-lg rounded-md border border-slate-200 bg-white p-6 text-center shadow-soft">
        <h1 className="text-xl font-semibold text-slate-950">{t("error.title")}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t("error.description")}
        </p>
        <button
          onClick={reset}
          className="focus-ring mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t("error.retry")}
        </button>
      </div>
    </div>
  );
}
