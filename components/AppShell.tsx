"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Navbar from "@/components/Navbar";
import PageViewLogger from "@/components/PageViewLogger";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = pathname === "/login";

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
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
