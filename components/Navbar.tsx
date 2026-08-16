"use client";

import LogoutButton from "@/components/LogoutButton";
import LanguageToggle from "@/components/LanguageToggle";
import GlobalExecutiveSearch from "@/components/search/GlobalExecutiveSearch";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";
import UserAvatar from "@/components/chat/UserAvatar";
import Link from "next/link";
import { isAdmin } from "@/lib/auth/roles";

export default function Navbar({ profile, isAdminArea = false }: { profile: Profile | null; isAdminArea?: boolean }) {
  const { t } = useLanguage();
  const roleLabel = isAdmin(profile?.role) ? t("navbar.adminWorkspace") : t("navbar.employeeWorkspace");

  return (
    <header className={`max-w-full overflow-hidden border-b bg-white ${isAdminArea ? "border-orange-200" : "border-slate-200"}`}>
      <div className="flex min-h-16 min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1 xl:flex-none">
          <p className={`text-sm font-medium ${isAdminArea ? "text-orange-700" : "text-slate-500"}`}>{roleLabel}</p>
          <h1 className="truncate text-lg font-semibold text-slate-950">{t("app.title")}</h1>
        </div>
        <div className="order-3 hidden w-full min-w-0 md:block xl:order-none xl:w-auto xl:flex-1">
          <GlobalExecutiveSearch />
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LanguageToggle />
          {profile ? (
            <Link
              href="/profile"
              className={`hidden rounded-md border px-3 py-2 text-sm sm:block ${
                isAdmin(profile.role)
                  ? "border-orange-200 bg-orange-50 text-orange-700"
                  : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
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
