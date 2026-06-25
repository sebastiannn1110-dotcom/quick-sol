"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import DataTable from "@/components/DataTable";
import { useLanguage } from "@/components/LanguageProvider";
import UploadHistory from "@/components/UploadHistory";
import type { PlatformRecord, Profile, UploadBatch } from "@/lib/types";

interface EmployeeWithCounts extends Profile {
  uploadCount: number;
  recordCount: number;
  lastUpload: string | null;
}

interface EmployeeDetailPayload {
  employee: Profile | null;
  uploads: UploadBatch[];
  records: PlatformRecord[];
  summary?: {
    uploadCount: number;
    recordCount: number;
    categories: string[];
    lastUpload: string | null;
  };
}

function EmployeesContent() {
  const { t, locale } = useLanguage();
  const searchParams = useSearchParams();
  const initialEmployee = searchParams.get("employee") ?? "";
  const [employees, setEmployees] = useState<EmployeeWithCounts[]>([]);
  const [employeeId, setEmployeeId] = useState(initialEmployee);
  const [detail, setDetail] = useState<EmployeeDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    const response = await fetch("/api/employees", { cache: "no-store" });
    const payload = (await response.json()) as { employees: EmployeeWithCounts[] };
    setEmployees(payload.employees ?? []);
    setLoading(false);
  }, []);

  const loadEmployeeDetail = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setDetailLoading(true);
    const response = await fetch(`/api/employees?employeeId=${encodeURIComponent(id.trim())}`, {
      cache: "no-store"
    });
    const payload = (await response.json()) as EmployeeDetailPayload;
    setDetail(payload);
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    if (!initialEmployee) return;
    setEmployeeId(initialEmployee);
    loadEmployeeDetail(initialEmployee);
  }, [initialEmployee, loadEmployeeDetail]);

  const roleLabel = (role: Profile["role"]) => {
    if (role === "admin") return t("role.admin");
    if (role === "manager") return t("role.manager");
    return t("role.employee");
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-700">{t("employees.eyebrow")}</p>
        <h1 className="text-2xl font-semibold text-slate-950">{t("employees.title")}</h1>
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            loadEmployeeDetail(employeeId);
          }}
        >
          <input
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            placeholder={t("employees.searchPlaceholder")}
            className="focus-ring min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-sm"
          />
          <button type="submit" className="focus-ring rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
            {t("employees.search")}
          </button>
        </form>
      </section>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="rounded-md border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-950">{t("employees.directory")}</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {loading ? (
              <p className="p-4 text-sm text-slate-500">{t("employees.loading")}</p>
            ) : (
              employees.map((employee) => (
                <button
                  key={employee.id}
                  type="button"
                  onClick={() => {
                    setEmployeeId(employee.id);
                    loadEmployeeDetail(employee.id);
                  }}
                  className="block w-full px-4 py-3 text-left hover:bg-slate-50"
                >
                  <p className="font-medium text-slate-950">{employee.full_name}</p>
                  <p className="text-sm text-slate-500">
                    {employee.email} · {employee.department ?? t("employees.noDepartment")} · {employee.region ?? t("employees.noRegion")}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {employee.uploadCount} {t("employees.uploads")} · {employee.recordCount} {t("employees.records")} · {roleLabel(employee.role)}
                  </p>
                </button>
              ))
            )}
          </div>
        </section>

        <div className="space-y-5">
          {detailLoading ? (
            <div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">{t("employees.loadingProfile")}</div>
          ) : null}

          {detail?.employee ? (
            <>
              <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-xl font-semibold text-slate-950">{detail.employee.full_name}</h2>
                <p className="text-sm text-slate-500">
                  {detail.employee.email} · {roleLabel(detail.employee.role)} · {detail.employee.department ?? t("employees.noDepartment")} · {detail.employee.region ?? t("employees.noRegion")}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs font-medium text-slate-500">{t("employees.uploadsLabel")}</p>
                    <p className="mt-1 text-xl font-semibold text-slate-950">{detail.summary?.uploadCount ?? 0}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs font-medium text-slate-500">{t("employees.recordsLabel")}</p>
                    <p className="mt-1 text-xl font-semibold text-slate-950">{detail.summary?.recordCount ?? 0}</p>
                  </div>
                  <div className="rounded-md bg-slate-50 p-3">
                    <p className="text-xs font-medium text-slate-500">{t("employees.lastUpload")}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-950">
                      {detail.summary?.lastUpload ? new Date(detail.summary.lastUpload).toLocaleString(locale) : t("employees.noUploads")}
                    </p>
                  </div>
                </div>
              </section>
              <UploadHistory uploads={detail.uploads} />
              <DataTable records={detail.records} />
            </>
          ) : (
            <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
              {t("employees.selectPrompt")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EmployeesPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading employees...</div>}>
      <EmployeesContent />
    </Suspense>
  );
}
