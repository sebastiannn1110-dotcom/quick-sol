"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  BriefcaseBusiness,
  Building2,
  Database,
  MessageCircle,
  UserCircle,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Upload,
  Users
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import QuiksolIcon from "@/components/QuiksolIcon";
import type { TranslationKey } from "@/lib/i18n";
import type { Profile, UserRole } from "@/lib/types";

interface NavItem {
  href: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  roles?: UserRole[];
}

const NAV_ITEMS: NavItem[] = [
  { href: "/clients", labelKey: "nav.clients", icon: Building2 },
  { href: "/opportunities", labelKey: "nav.opportunities", icon: BriefcaseBusiness },
  { href: "/stock-needs", labelKey: "nav.stockNeeds", icon: Boxes },
  { href: "/mpn-comparator", labelKey: "nav.mpnComparator", icon: Scale },
  { href: "/executive-search", labelKey: "nav.executiveSearch", icon: Search },
  { href: "/chat", labelKey: "nav.chat", icon: MessageCircle },
  { href: "/profile", labelKey: "nav.profile", icon: UserCircle },
  { href: "/upload", labelKey: "nav.uploads", icon: Upload, roles: ["admin", "manager"] },
  { href: "/employees", labelKey: "nav.users", icon: Users, roles: ["admin", "manager"] },
  { href: "/records", labelKey: "nav.records", icon: Database, roles: ["admin", "manager"] },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, roles: ["admin", "manager"] },
  { href: "/admin/clients", labelKey: "nav.clientsAdmin", icon: Building2, roles: ["admin", "manager"] },
  { href: "/admin", labelKey: "nav.admin", icon: ShieldCheck, roles: ["admin"] }
];

export default function Sidebar({ profile, isAdminArea = false }: { profile: Profile | null; isAdminArea?: boolean }) {
  const pathname = usePathname();
  const { t } = useLanguage();
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (!item.roles) return true;
    return profile ? item.roles.includes(profile.role) : false;
  });

  return (
    <aside
      className={`border-b text-white lg:min-h-screen lg:w-72 lg:border-b-0 lg:border-r ${
        isAdminArea ? "border-orange-900 bg-orange-950" : "border-slate-200 bg-slate-950 lg:border-slate-800"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-6 lg:py-6">
        <Link href="/clients" className="flex items-center gap-3">
          <QuiksolIcon size={40} className={isAdminArea ? "ring-1 ring-orange-300" : "ring-1 ring-brand-400"} />
          <span>
            <span className="block text-base font-semibold">Quiksol</span>
            <span className={`block text-xs ${isAdminArea ? "text-orange-200" : "text-slate-400"}`}>
              {profile?.role === "admin" ? t("app.subtitle.admin") : t("app.subtitle.employee")}
            </span>
          </span>
        </Link>
      </div>
      <nav className="flex gap-2 overflow-x-auto px-4 pb-4 lg:block lg:space-y-1 lg:overflow-visible lg:px-4">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-w-fit items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-white text-slate-950"
                  : isAdminArea
                    ? "text-orange-100 hover:bg-orange-900 hover:text-white"
                    : "text-slate-300 hover:bg-slate-900 hover:text-white"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold ${
                  active
                    ? isAdminArea
                      ? "bg-orange-100 text-orange-700"
                      : "bg-brand-100 text-brand-700"
                    : isAdminArea
                      ? "bg-orange-900 text-orange-100"
                      : "bg-slate-900 text-slate-300"
                }`}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
              </span>
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
