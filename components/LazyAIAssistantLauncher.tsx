"use client";

import dynamic from "next/dynamic";
import { Bot } from "lucide-react";
import { useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

const AIAssistantWidget = dynamic(() => import("@/components/AIAssistantWidget"), {
  ssr: false,
  loading: () => null
});

export default function LazyAIAssistantLauncher({ profile }: { profile: Profile | null }) {
  const { t } = useLanguage();
  const [loaded, setLoaded] = useState(false);

  if (loaded) return <AIAssistantWidget profile={profile} initialOpen />;

  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      className="focus-ring fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full border border-slate-200 bg-white text-brand-700 shadow-xl transition hover:scale-105"
      aria-label={t("assistant.open")}
      aria-expanded="false"
    >
      <Bot className="h-7 w-7" aria-hidden="true" />
    </button>
  );
}
