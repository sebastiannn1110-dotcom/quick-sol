"use client";

import LogoutButton from "@/components/LogoutButton";
import LanguageToggle from "@/components/LanguageToggle";
import GlobalExecutiveSearch from "@/components/search/GlobalExecutiveSearch";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";
import UserAvatar from "@/components/chat/UserAvatar";
import Link from "next/link";
import { isAdmin } from "@/lib/auth/roles";

export default function Navbar({ profile }: { profile: Profile | null; isAdminArea?: boolean }) {
  const { t } = useLanguage();
  const roleLabel = isAdmin(profile?.role) ? t("navbar.adminWorkspace") : t("navbar.employeeWorkspace");

  return (
    <header className="sticky top-0 z-30 max-w-full overflow-hidden border-b border-slate-200/90 bg-white/95 backdrop-blur">
      <div className="flex min-h-16 min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 xl:flex-none">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{roleLabel}</p>
          <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-slate-950">{t("app.title")}</h1>
        </div>
        <div className="order-3 hidden w-full min-w-0 md:block xl:order-none xl:w-auto xl:flex-1">
          <GlobalExecutiveSearch />
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LanguageToggle />
          {profile ? (
            <Link
              href="/profile"
              className="focus-ring hidden rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 hover:border-slate-300 hover:bg-white sm:block"
            >
              <span className="flex items-center gap-2"><UserAvatar name={profile.full_name} avatarPath={profile.avatar_path} size="sm" />{profile.full_name}</span>
            </Link>
          ) : null}
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
