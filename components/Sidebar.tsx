"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "D" },
  { href: "/upload", label: "Upload", icon: "U" },
  { href: "/records", label: "Records", icon: "R" },
  { href: "/categories", label: "Categories", icon: "C" },
  { href: "/analytics", label: "Analytics", icon: "A" },
  { href: "/admin", label: "Admin", icon: "AD" },
  { href: "/settings", label: "Settings", icon: "S" }
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="border-b border-slate-200 bg-slate-950 text-white lg:min-h-screen lg:w-72 lg:border-b-0 lg:border-r lg:border-slate-800">
      <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-6 lg:py-6">
        <Link href="/dashboard" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-brand-500 text-sm font-bold">
            QS
          </span>
          <span>
            <span className="block text-base font-semibold">Quiksol</span>
            <span className="block text-xs text-slate-400">Excel Intelligence</span>
          </span>
        </Link>
      </div>
      <nav className="flex gap-2 overflow-x-auto px-4 pb-4 lg:block lg:space-y-1 lg:overflow-visible lg:px-4">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-w-fit items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-white text-slate-950"
                  : "text-slate-300 hover:bg-slate-900 hover:text-white"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold ${
                  active ? "bg-brand-100 text-brand-700" : "bg-slate-900 text-slate-300"
                }`}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
