"use client";

import { FormEvent, useEffect, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import { useLanguage } from "@/components/LanguageProvider";
import type { Profile } from "@/lib/types";

type UserForm = {
  id?: string;
  full_name: string;
  email: string;
  role: Profile["role"];
  department: string;
  region: string;
  password: string;
};

const EMPTY_FORM: UserForm = {
  full_name: "",
  email: "",
  role: "employee",
  department: "",
  region: "",
  password: ""
};

export default function AdminUsersPage() {
  const { t } = useLanguage();
  const [users, setUsers] = useState<Profile[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadUsers() {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as { users: Profile[] };
      setUsers(payload.users ?? []);
    }
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

  function openCreate() {
    setForm(EMPTY_FORM);
    setMessage(null);
    setError(null);
    setModalMode("create");
  }

  function openEdit(user: Profile) {
    setForm({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      department: user.department ?? "",
      region: user.region ?? "",
      password: ""
    });
    setMessage(null);
    setError(null);
    setModalMode("edit");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const payload = {
      full_name: form.full_name.trim(),
      email: form.email.trim(),
      role: form.role,
      department: form.department.trim() || null,
      region: form.region.trim() || null,
      ...(form.password.trim() ? { password: form.password.trim() } : {})
    };

    const response = await fetch("/api/admin/users", {
      method: modalMode === "create" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modalMode === "create" ? payload : { userId: form.id, ...payload })
    });
    const result = (await response.json()) as { error?: string; temporaryPassword?: string };
    if (!response.ok) {
      setError(result.error ?? "Unable to save employee.");
      return;
    }
    setMessage(
      modalMode === "create" && result.temporaryPassword
        ? `Employee created. Temporary password: ${result.temporaryPassword}`
        : "Employee saved."
    );
    setModalMode(null);
    loadUsers();
  }

  async function setActive(user: Profile, isActive: boolean) {
    const confirmed = isActive || window.confirm(`Deactivate ${user.full_name}? This is a soft delete; historical uploads stay traceable.`);
    if (!confirmed) return;
    const response = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, is_active: isActive })
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Unable to update employee.");
      return;
    }
    loadUsers();
  }

  return (
    <AdminGuard>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-orange-700">{t("nav.admin")}</p>
            <h1 className="text-2xl font-semibold text-slate-950">{t("admin.usersTitle")}</h1>
          </div>
          <button type="button" onClick={openCreate} className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700">
            Create Employee
          </button>
        </div>

        {message ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p> : null}
        {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("admin.searchUsers")} className="focus-ring w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm" />

        <section className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
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
                    <td className="px-4 py-3 text-slate-600">{user.role}</td>
                    <td className="px-4 py-3 text-slate-600">{user.department ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{user.region ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{user.is_active ? t("admin.active") : t("admin.inactive")}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button onClick={() => openEdit(user)} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                          Edit
                        </button>
                        <button onClick={() => setActive(user, !user.is_active)} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                          {user.is_active ? t("admin.deactivate") : t("admin.activate")}
                        </button>
                        <a href={`/admin/uploads?employee=${user.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                          View Uploads
                        </a>
                        <a href={`/admin/records?uploadedBy=${user.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                          View Records
                        </a>
                        <a href={`/employees?employee=${user.id}`} className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                          View Analytics
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {modalMode ? (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-4 sm:items-center">
            <section className="w-full max-w-2xl rounded-md bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
                <div>
                  <p className="text-sm font-medium text-orange-700">{modalMode === "create" ? "Create Employee" : "Edit Employee"}</p>
                  <h2 className="text-xl font-semibold text-slate-950">{form.full_name || "New employee"}</h2>
                </div>
                <button type="button" onClick={() => setModalMode(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
                  {t("table.close")}
                </button>
              </div>
              <form onSubmit={handleSubmit} className="grid gap-4 p-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Full name
                  <input required value={form.full_name} onChange={(event) => setForm((current) => ({ ...current, full_name: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Email
                  <input required type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Role
                  <select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as Profile["role"] }))} className="focus-ring rounded-md border border-slate-300 bg-white px-3 py-2.5 font-normal">
                    <option value="employee">{t("role.employee")}</option>
                    <option value="manager">{t("role.manager")}</option>
                    <option value="admin">{t("role.admin")}</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Department
                  <input value={form.department} onChange={(event) => setForm((current) => ({ ...current, department: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Region
                  <input value={form.region} onChange={(event) => setForm((current) => ({ ...current, region: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                {modalMode === "create" ? (
                  <label className="grid gap-1 text-sm font-medium text-slate-700">
                    Temporary password
                    <input value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="Auto-generate if empty" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                  </label>
                ) : null}
                <div className="sm:col-span-2 flex justify-end">
                  <button type="submit" className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700">
                    {modalMode === "create" ? "Create Employee" : "Save Employee"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}
      </div>
    </AdminGuard>
  );
}
