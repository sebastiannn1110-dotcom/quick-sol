import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DirectoryProfile {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "manager" | "employee";
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
  if (!result.error) return { employees: result.data ?? [], error: null };

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
  return { employees: fallback.data ?? [], error: fallback.error };
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const employeeId = searchParams.get("employeeId")?.trim();
  const search = searchParams.get("q")?.trim().slice(0, 100) || null;
  const isAdmin = context.profile.role === "admin";

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    const profiles = data.profiles.map((profile) => ({
      ...profile,
      uploadCount: data.uploads.filter((upload) => upload.uploaded_by === profile.id).length,
      recordCount: data.records.filter((record) => record.uploaded_by === profile.id).length,
      lastUpload: data.uploads.find((upload) => upload.uploaded_by === profile.id)?.created_at ?? null
    }));
    if (employeeId) {
      const employee = profiles.find((profile) => profile.id === employeeId) ?? null;
      const uploads = data.uploads.filter((upload) => upload.uploaded_by === employeeId);
      const records = data.records.filter((record) => record.uploaded_by === employeeId);
      return NextResponse.json({ employee, uploads, records, summary: { uploadCount: uploads.length, recordCount: records.length, lastUpload: uploads[0]?.created_at ?? null } });
    }
    return NextResponse.json({ employees: profiles });
  }

  const directory = await loadDirectory(context, search);
  if (directory.error) return NextResponse.json({ error: "Unable to load employees." }, { status: 500 });
  const employees = directory.employees as DirectoryProfile[];

  if (employeeId) {
    const employee = employees.find((profile) => profile.id === employeeId) ?? null;
    if (!employee) return NextResponse.json({ employee: null, uploads: [], records: [] }, { status: 404 });

    const canViewActivity = isAdmin || employeeId === context.profile.id;
    if (!canViewActivity) {
      return NextResponse.json({ employee, uploads: [], records: [], privateActivity: true });
    }

    const [{ data: uploads }, { data: records }] = await Promise.all([
      context.supabase!
        .from("upload_batches")
        .select("*, profiles(full_name,email,department,region,role)")
        .eq("uploaded_by", employeeId)
        .order("created_at", { ascending: false }),
      context.supabase!
        .from("business_records")
        .select("*, profiles(full_name,email,department,region,role), upload_batches(original_file_name,detected_category,status)")
        .eq("uploaded_by", employeeId)
        .order("created_at", { ascending: false })
        .limit(100)
    ]);

    return NextResponse.json({
      employee,
      uploads: uploads ?? [],
      records: records ?? [],
      summary: {
        uploadCount: uploads?.length ?? 0,
        recordCount: records?.length ?? 0,
        categories: Array.from(new Set((records ?? []).map((record) => record.category ?? "Generic"))),
        lastUpload: uploads?.[0]?.created_at ?? null
      }
    });
  }

  if (isAdmin) {
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
      return NextResponse.json({
        employees: employees.map((employee) => ({ ...employee, ...(counts.get(employee.id) ?? { uploadCount: 0, recordCount: 0, lastUpload: null }) }))
      });
    }
  }

  return NextResponse.json({
    employees: employees.map((employee) => ({ ...employee, uploadCount: 0, recordCount: 0, lastUpload: null }))
  });
}
