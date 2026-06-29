"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Navbar from "@/components/Navbar";
import PageViewLogger from "@/components/PageViewLogger";
import AIAssistantWidget from "@/components/AIAssistantWidget";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = ["/login", "/forgot-password", "/reset-password"].includes(pathname);
  const isAdminArea = pathname.startsWith("/admin");
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    if (isPublicPage) return;

    async function loadProfile() {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { profile: Profile };
        setProfile(payload.profile);
      }
    }

    loadProfile();
  }, [isPublicPage]);

  if (isPublicPage) {
    return (
      <main className="min-h-screen bg-slate-50">
        <PageViewLogger />
        {children}
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      <PageViewLogger />
      <Sidebar profile={profile} isAdminArea={isAdminArea} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar profile={profile} isAdminArea={isAdminArea} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
      <AIAssistantWidget profile={profile} />
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <ShellContent>{children}</ShellContent>
    </LanguageProvider>
  );
}
