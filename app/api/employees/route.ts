import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { isAdmin } from "@/lib/auth/roles";
import type { UserRole } from "@/lib/types";
import { businessRecordReadContract } from "@/lib/security/business-records";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  scopeElectronicPartsDemoEmployees
} from "@/lib/demo/employee-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEMO_EMPLOYEE_COUNT = ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.length;
const DEMO_EMPLOYEE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Electronic-Parts-Employee-Scope": String(DEMO_EMPLOYEE_COUNT)
};

function employeeJson(body: unknown, init: ResponseInit = {}) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...DEMO_EMPLOYEE_HEADERS, ...init.headers }
  });
}

interface DirectoryProfile {
  id: string;
  full_name: string;
  email: string;
  role: UserRole;
  department: string | null;
  region: string | null;
  avatar_path?: string | null;
  bio?: string | null;
  job_title?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  uploadCount?: number;
  recordCount?: number;
  lastUpload?: string | null;
}

async function loadDirectory(context: Awaited<ReturnType<typeof getAuthContext>>, search: string | null) {
  if (context instanceof NextResponse || context.isDemoMode || !context.supabase) return { employees: [], error: null };
  const result = await context.supabase.rpc("list_employee_directory", { search_text: search });
  if (!result.error) {
    return {
      employees: scopeElectronicPartsDemoEmployees((result.data ?? []) as DirectoryProfile[]),
      error: null
    };
  }

  const safeSearch = search?.replace(/[%,()]/g, " ").trim();
  const query = context.supabase
    .from("profiles")
    .select("id,full_name,email,role,department,region,avatar_path,bio,job_title,is_active,created_at,updated_at")
    .eq("is_active", true)
    .order("full_name")
    .limit(500);
  const fallback = safeSearch
    ? await query.or(`full_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%,department.ilike.%${safeSearch}%,region.ilike.%${safeSearch}%,job_title.ilike.%${safeSearch}%`)
    : await query;
  return {
    employees: scopeElectronicPartsDemoEmployees((fallback.data ?? []) as DirectoryProfile[]),
    error: fallback.error
  };
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const employeeId = searchParams.get("employeeId")?.trim();
  const search = searchParams.get("q")?.trim().slice(0, 100) || null;
  const hasAdminAccess = isAdmin(context.profile.role);

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    const activeRecords = data.records.filter((record) => record.archived_at === null);
    const profiles = scopeElectronicPartsDemoEmployees(data.profiles).map((profile) => ({
      ...profile,
      uploadCount: data.uploads.filter((upload) => upload.uploaded_by === profile.id).length,
      recordCount: activeRecords.filter((record) => record.uploaded_by === profile.id).length,
      lastUpload: data.uploads.find((upload) => upload.uploaded_by === profile.id)?.created_at ?? null
    }));
    if (employeeId) {
      const employee = profiles.find((profile) => profile.id === employeeId) ?? null;
      const uploads = data.uploads.filter((upload) => upload.uploaded_by === employeeId);
      const records = activeRecords.filter((record) => record.uploaded_by === employeeId);
      return employeeJson({ employee, uploads, records, summary: { uploadCount: uploads.length, recordCount: records.length, lastUpload: uploads[0]?.created_at ?? null } });
    }
    return employeeJson({ employees: profiles });
  }

  const directory = await loadDirectory(context, search);
  if (directory.error) return employeeJson({ error: "Unable to load employees." }, { status: 500 });
  const employees = directory.employees as DirectoryProfile[];

  if (!employeeId && !search && employees.length !== DEMO_EMPLOYEE_COUNT) {
    return employeeJson(
      { error: "Demo employee scope is incomplete.", code: "DEMO_EMPLOYEE_SCOPE_INCOMPLETE" },
      { status: 500 }
    );
  }

  if (employeeId) {
    const employee = employees.find((profile) => profile.id === employeeId) ?? null;
    if (!employee) return employeeJson({ employee: null, uploads: [], records: [] }, { status: 404 });

    const canViewActivity = hasAdminAccess || employeeId === context.profile.id;
    if (!canViewActivity) {
      return employeeJson({ employee, uploads: [], records: [], privateActivity: true });
    }

    const recordContract = businessRecordReadContract(context.profile.role);
    const [{ data: uploads }, { data: records }] = await Promise.all([
      context.supabase!
        .from("upload_batches")
        .select("*, profiles(full_name,email,department,region,role)")
        .eq("uploaded_by", employeeId)
        .order("created_at", { ascending: false }),
      context.supabase!
        .from(recordContract.table)
        .select(recordContract.select)
        .eq("uploaded_by", employeeId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(100)
    ]);

    const safeRecords = (records ?? []) as unknown as Array<Record<string, unknown> & { category?: string | null }>;
    return employeeJson({
      employee,
      uploads: uploads ?? [],
      records: safeRecords,
      summary: {
        uploadCount: uploads?.length ?? 0,
        recordCount: records?.length ?? 0,
        categories: Array.from(new Set(safeRecords.map((record) => record.category ?? "Generic"))),
        lastUpload: uploads?.[0]?.created_at ?? null
      }
    });
  }

  if (hasAdminAccess) {
    const activityResult = await context.supabase!.rpc("get_employee_activity_directory");
    if (!activityResult.error && activityResult.data) {
      const counts = new Map(activityResult.data.map((profile: { id: string; upload_count?: number | string; record_count?: number | string; last_upload?: string | null }) => [
        profile.id,
        {
          uploadCount: Number(profile.upload_count ?? 0),
          recordCount: Number(profile.record_count ?? 0),
          lastUpload: profile.last_upload ?? null
        }
      ]));
      return employeeJson({
        employees: employees.map((employee) => ({ ...employee, ...(counts.get(employee.id) ?? { uploadCount: 0, recordCount: 0, lastUpload: null }) }))
      });
    }
  }

  return employeeJson({
    employees: employees.map((employee) => ({ ...employee, uploadCount: 0, recordCount: 0, lastUpload: null }))
  });
}
