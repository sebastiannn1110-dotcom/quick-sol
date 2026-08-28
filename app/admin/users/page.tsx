"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import AdminGuard from "@/components/AdminGuard";
import { useLanguage } from "@/components/LanguageProvider";
import { useProfile } from "@/components/ProfileProvider";
import { isSuperAdminDev } from "@/lib/auth/roles";
import type { Profile } from "@/lib/types";
import UserAvatar from "@/components/chat/UserAvatar";

type UserForm = {
  id?: string;
  full_name: string;
  email: string;
  role: Profile["role"];
  department: string;
  region: string;
  bio: string;
  job_title: string;
  password: string;
};

type UserMutationResponse = {
  error?: string;
  code?: string;
  created?: boolean;
  reused?: boolean;
  recovered?: boolean;
  temporaryPasswordAvailable?: boolean;
  temporaryPassword?: string;
};

const EMPTY_FORM: UserForm = {
  full_name: "",
  email: "",
  role: "employee",
  department: "",
  region: "",
  bio: "",
  job_title: "",
  password: ""
};

export default function AdminUsersPage() {
  const { t } = useLanguage();
  const { profile: currentProfile } = useProfile();
  const hasPrivilegedRoleManagement = isSuperAdminDev(currentProfile?.role);
  const [users, setUsers] = useState<Profile[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createOperationKeyRef = useRef<string | null>(null);
  const submitLockRef = useRef(false);

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
    [user.full_name, user.email, user.role, user.department, user.region, user.job_title, user.bio]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  function openCreate() {
    if (submitLockRef.current) return;
    setForm(EMPTY_FORM);
    setMessage(null);
    setError(null);
    createOperationKeyRef.current = crypto.randomUUID();
    setModalMode("create");
  }

  function openEdit(user: Profile) {
    if (submitLockRef.current) return;
    setForm({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      department: user.department ?? "",
      region: user.region ?? "",
      bio: user.bio ?? "",
      job_title: user.job_title ?? "",
      password: ""
    });
    setMessage(null);
    setError(null);
    createOperationKeyRef.current = null;
    setModalMode("edit");
  }

  function closeModal() {
    if (submitLockRef.current) return;
    createOperationKeyRef.current = null;
    setModalMode(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current || !modalMode) return;

    submitLockRef.current = true;
    setIsSubmitting(true);
    setMessage(null);
    setError(null);

    const submissionMode = modalMode;
    const operationKey = submissionMode === "create"
      ? (createOperationKeyRef.current ??= crypto.randomUUID())
      : null;

    const payload = {
      full_name: form.full_name.trim(),
      email: form.email.trim(),
      role: form.role,
      department: form.department.trim() || null,
      region: form.region.trim() || null,
      bio: form.bio.trim() || null,
      job_title: form.job_title.trim() || null,
      ...(form.password.trim() ? { password: form.password.trim() } : {})
    };

    try {
      const response = await fetch("/api/admin/users", {
        method: submissionMode === "create" ? "POST" : "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(operationKey ? { "Idempotency-Key": operationKey } : {})
        },
        body: JSON.stringify(submissionMode === "create" ? payload : { userId: form.id, ...payload })
      });

      let result: UserMutationResponse = {};
      try {
        result = (await response.json()) as UserMutationResponse;
      } catch {
        // Keep the stable operation key when an upstream response is malformed.
      }

      if (!response.ok) {
        setError(
          result.code === "PROVISIONING_RETRYABLE"
            ? "The creation result is uncertain. Retry this form; the same operation will be reused."
            : result.error ?? "Unable to save employee."
        );
        return;
      }

      if (submissionMode === "create" && result.created !== true) {
        setError("The creation result is uncertain. Retry this form; the same operation will be reused.");
        return;
      }

      if (submissionMode === "create") {
        if (result.recovered || result.reused) {
          setMessage(
            result.temporaryPasswordAvailable && result.temporaryPassword
              ? `Employee creation resumed. Temporary password: ${result.temporaryPassword}`
              : "Employee creation recovered from a retry. The temporary password cannot be recovered; use the credential recovery flow."
          );
        } else if (result.temporaryPasswordAvailable && result.temporaryPassword) {
          setMessage(`Employee created. Temporary password: ${result.temporaryPassword}`);
        } else {
          setMessage("Employee created.");
        }
        createOperationKeyRef.current = null;
      } else {
        setMessage("Employee saved.");
      }

      setModalMode(null);
      void loadUsers();
    } catch {
      setError(
        submissionMode === "create"
          ? "The creation result is uncertain. Retry this form; the same operation will be reused."
          : "Unable to save employee."
      );
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
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
          <button type="button" onClick={openCreate} disabled={isSubmitting} className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50">
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
                      <div className="flex items-center gap-3">
                        <UserAvatar name={user.full_name} avatarPath={user.avatar_path} size="sm" />
                        <div><p className="font-medium text-slate-950">{user.full_name}</p><p className="text-xs text-slate-500">{user.email}</p>{user.job_title ? <p className="text-xs text-slate-400">{user.job_title}</p> : null}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{user.role}</td>
                    <td className="px-4 py-3 text-slate-600">{user.department ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{user.region ?? "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{user.is_active ? t("admin.active") : t("admin.inactive")}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {user.role !== "super_admin_dev" || hasPrivilegedRoleManagement ? (
                          <>
                            <button onClick={() => openEdit(user)} disabled={isSubmitting} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
                              Edit
                            </button>
                            <button onClick={() => setActive(user, !user.is_active)} className="focus-ring rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700">
                              {user.is_active ? t("admin.deactivate") : t("admin.activate")}
                            </button>
                          </>
                        ) : null}
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
                <button type="button" onClick={closeModal} disabled={isSubmitting} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
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
                    {hasPrivilegedRoleManagement ? <option value="super_admin_dev">Super Admin Dev</option> : null}
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
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Cargo visible
                  <input value={form.job_title} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, job_title: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                {modalMode === "create" ? (
                  <label className="grid gap-1 text-sm font-medium text-slate-700">
                    Temporary password
                    <input value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} placeholder="Auto-generate if empty" className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                  </label>
                ) : null}
                <label className="grid gap-1 text-sm font-medium text-slate-700 sm:col-span-2">
                  Descripcion interna
                  <textarea value={form.bio} maxLength={500} rows={4} onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))} className="focus-ring rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <div className="sm:col-span-2 flex justify-end">
                  <button type="submit" disabled={isSubmitting} className="focus-ring rounded-md bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50">
                    {isSubmitting
                      ? modalMode === "create" ? "Creating..." : "Saving..."
                      : modalMode === "create" ? "Create Employee" : "Save Employee"}
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
