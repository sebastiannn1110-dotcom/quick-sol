"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  Building2,
  Database,
  MessageCircle,
  Network,
  UserCircle,
  Search,
  ShieldCheck,
  ShieldPlus,
  Upload,
  Users
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import BrandMark from "@/components/BrandMark";
import type { TranslationKey } from "@/lib/i18n";
import type { Profile, UserRole } from "@/lib/types";
import { isAdmin, roleSatisfiesAny } from "@/lib/auth/roles";
import { canManageSourcing } from "@/lib/sourcing/permissions";

interface NavItem {
  href: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  roles?: UserRole[];
  sourcingOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/clients", labelKey: "nav.clients", icon: Building2 },
  { href: "/opportunity-finder", labelKey: "nav.opportunityFinder", icon: BriefcaseBusiness },
  { href: "/stock-needs", labelKey: "nav.stockNeeds", icon: Boxes },
  { href: "/executive-search", labelKey: "nav.executiveSearch", icon: Search },
  { href: "/chat", labelKey: "nav.chat", icon: MessageCircle },
  { href: "/profile", labelKey: "nav.profile", icon: UserCircle },
  { href: "/upload", labelKey: "nav.uploads", icon: Upload, roles: ["admin", "manager"] },
  { href: "/employees", labelKey: "nav.users", icon: Users, roles: ["admin", "manager"] },
  { href: "/records", labelKey: "nav.records", icon: Database, roles: ["admin", "manager"] },
  { href: "/admin/clients", labelKey: "nav.clientsAdmin", icon: Building2, roles: ["admin", "manager"] },
  { href: "/admin/sourcing", labelKey: "nav.sourcing", icon: BriefcaseBusiness, sourcingOnly: true },
  { href: "/admin/employee-analytics", labelKey: "nav.employeeAnalytics", icon: BarChart3, roles: ["employee", "manager", "admin"] },
  { href: "/admin/team-structure", labelKey: "nav.teamStructure", icon: Network, roles: ["manager", "admin"] },
  { href: "/admin", labelKey: "nav.admin", icon: ShieldCheck, roles: ["admin"] },
  { href: "/admindev", labelKey: "nav.superAdminDev", icon: ShieldPlus, roles: ["super_admin_dev"] }
];

export default function Sidebar({ profile }: { profile: Profile | null; isAdminArea?: boolean }) {
  const pathname = usePathname();
  const { t } = useLanguage();
  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.sourcingOnly) return canManageSourcing(profile);
    if (!item.roles) return true;
    return profile ? roleSatisfiesAny(profile.role, item.roles) : false;
  });

  return (
    <aside
      className="w-full max-w-full overflow-hidden border-b border-slate-800 bg-[#0b1220] text-white lg:sticky lg:top-0 lg:min-h-screen lg:w-72 lg:self-start lg:border-b-0 lg:border-r"
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-4 lg:block lg:px-6 lg:py-6">
        <Link href="/clients" className="flex min-h-11 items-center gap-3 rounded-lg focus-ring">
          <BrandMark size={42} label="Electronic Parts microchip mark" className="ring-1 ring-blue-300/30" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-base font-semibold tracking-tight">Electronic Parts</span>
              <span className="rounded-full border border-blue-300/20 bg-blue-400/10 px-2 py-0.5 text-[9px] font-bold tracking-[0.16em] text-blue-200">DEMO</span>
            </span>
            <span className="mt-0.5 block text-[10px] font-semibold tracking-[0.17em] text-slate-400">
              {isAdmin(profile?.role) ? "ADMIN PLATFORM" : "B2B PLATFORM"}
            </span>
          </span>
        </Link>
      </div>
      <nav aria-label="Primary navigation" className="flex min-w-0 max-w-full gap-2 overflow-x-auto px-4 py-3 lg:block lg:space-y-1 lg:overflow-visible lg:px-4 lg:py-5">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`focus-ring flex min-w-fit items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium ${
                active
                  ? "bg-brand-600 text-white shadow-sm"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold ${
                  active ? "bg-white/15 text-white" : "bg-slate-800 text-slate-300"
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
