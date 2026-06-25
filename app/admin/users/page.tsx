"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

export default function AdminUsersPage() {
  const { t } = useLanguage();
  const [users, setUsers] = useState<Profile[]>([]);
  const [search, setSearch] = useState("");

  async function loadUsers() {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { users: Profile[] };
      setUsers(payload.users ?? []);
    }
  }

  async function updateUser(userId: string, update: Partial<Pick<Profile, "role" | "is_active">>) {
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...update })
    });
    loadUsers();
  }

  useEffect(() => {
    loadUsers();
  }, []);

  const visibleUsers = users.filter((user) =>
    [user.full_name, user.email, user.role, user.department, user.region]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-orange-700">{t("nav.admin")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{t("admin.usersTitle")}</h1>
        </div>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin.searchUsers")} className="focus-ring w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("admin.user")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("admin.role")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("admin.department")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("admin.region")}</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">{t("admin.status")}</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">{t("admin.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleUsers.map((user) => (
                <tr key={user.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-950">{user.full_name}</p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <select value={user.role} onChange={(event) => updateUser(user.id, { role: event.target.value as Profile["role"] })} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
                      <option value="employee">{t("role.employee")}</option>
                      <option value="manager">{t("role.manager")}</option>
                      <option value="admin">{t("role.admin")}</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{user.department ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">{user.region ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">{user.is_active ? t("admin.active") : t("admin.inactive")}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => updateUser(user.id, { is_active: !user.is_active })} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                      {user.is_active ? t("admin.deactivate") : t("admin.activate")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </AdminGuard>
  );
}
