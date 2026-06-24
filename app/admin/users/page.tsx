"use client";

import { useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import type { Profile } from "@/lib/types";

export default function AdminUsersPage() {
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
          <p className="text-sm font-medium text-brand-700">Admin</p>
          <h1 className="text-2xl font-semibold text-slate-950">Users</h1>
        </div>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search users" className="focus-ring w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm" />
        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">User</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Role</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Department</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Region</th>
                <th className="px-4 py-3 text-left font-semibold text-slate-600">Status</th>
                <th className="px-4 py-3 text-right font-semibold text-slate-600">Actions</th>
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
                      <option value="employee">employee</option>
                      <option value="manager">manager</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{user.department ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">{user.region ?? "-"}</td>
                  <td className="px-4 py-3 text-slate-600">{user.is_active ? "Active" : "Inactive"}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => updateUser(user.id, { is_active: !user.is_active })} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                      {user.is_active ? "Deactivate" : "Activate"}
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
