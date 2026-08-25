"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Navbar from "@/components/Navbar";
import PageViewLogger from "@/components/PageViewLogger";
import LazyAIAssistantLauncher from "@/components/LazyAIAssistantLauncher";
import { LanguageProvider } from "@/components/LanguageProvider";
import { ProfileProvider, useProfile } from "@/components/ProfileProvider";

function ShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = ["/login", "/forgot-password", "/reset-password"].includes(pathname);
  const isSuperadminArea = pathname.startsWith("/admindev");
  const isAdminArea = pathname.startsWith("/admin");
  const { profile } = useProfile();

  if (isSuperadminArea) {
    return <main className="min-h-screen bg-slate-950">{children}</main>;
  }

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
      <LazyAIAssistantLauncher profile={profile} />
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <LanguageProvider>
      <ProfileProvider>
        <ShellContent>{children}</ShellContent>
      </ProfileProvider>
    </LanguageProvider>
  );
}
