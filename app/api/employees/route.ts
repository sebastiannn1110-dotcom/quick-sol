import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const employeeId = searchParams.get("employeeId")?.trim();
  const isAdmin = context.profile.role === "admin";

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    if (employeeId) {
      const employee = data.profiles.find((profile) => profile.id === employeeId) ?? null;
      const uploads = data.uploads.filter((upload) => upload.uploaded_by === employeeId);
      const records = data.records.filter((record) => record.uploaded_by === employeeId);
      return NextResponse.json({
        employee,
        uploads,
        records,
        summary: {
          uploadCount: uploads.length,
          recordCount: records.length,
          categories: Array.from(new Set(records.map((record) => record.category ?? "Generic"))),
          lastUpload: uploads[0]?.created_at ?? null
        }
      });
    }

    return NextResponse.json({
      employees: data.profiles.map((profile) => ({
        ...profile,
        uploadCount: data.uploads.filter((upload) => upload.uploaded_by === profile.id).length,
        recordCount: data.records.filter((record) => record.uploaded_by === profile.id).length,
        lastUpload: data.uploads.find((upload) => upload.uploaded_by === profile.id)?.created_at ?? null
      }))
    });
  }

  if (employeeId) {
    if (!isAdmin && employeeId !== context.profile.id) {
      return NextResponse.json({ error: "You can only view your own employee data." }, { status: 403 });
    }
    const [{ data: employee }, { data: uploads }, { data: records }] = await Promise.all([
      context.supabase!.from("profiles").select("*").eq("id", employeeId).single(),
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

  if (!isAdmin) {
    return NextResponse.json({
      employees: [
        {
          ...context.profile,
          uploadCount: 0,
          recordCount: 0,
          lastUpload: null
        }
      ]
    });
  }

  const directoryResult = await context.supabase!.rpc("get_employee_activity_directory");
  if (!directoryResult.error) {
    return NextResponse.json({
      employees: (directoryResult.data ?? []).map((profile: {
        id: string;
        full_name: string;
        email: string;
        role: string;
        department: string | null;
        region: string | null;
        is_active: boolean;
        avatar_path: string | null;
        created_at: string;
        updated_at: string;
        upload_count: number | string;
        record_count: number | string;
        last_upload: string | null;
      }) => ({
        ...profile,
        uploadCount: Number(profile.upload_count ?? 0),
        recordCount: Number(profile.record_count ?? 0),
        lastUpload: profile.last_upload ?? null
      }))
    });
  }

  const { data: profiles, error } = await context.supabase!
    .from("profiles")
    .select("*")
    .order("full_name");

  if (error) return NextResponse.json({ error: "Unable to load employees." }, { status: 500 });

  const employees = await Promise.all(
    (profiles ?? []).map(async (profile) => {
      const [{ count: uploadCount }, { count: recordCount }, { data: lastUpload }] = await Promise.all([
        context.supabase!
          .from("upload_batches")
          .select("id", { count: "exact", head: true })
          .eq("uploaded_by", profile.id),
        context.supabase!
          .from("business_records")
          .select("id", { count: "exact", head: true })
          .eq("uploaded_by", profile.id),
        context.supabase!
          .from("upload_batches")
          .select("created_at")
          .eq("uploaded_by", profile.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      ]);

      return {
        ...profile,
        uploadCount: uploadCount ?? 0,
        recordCount: recordCount ?? 0,
        lastUpload: lastUpload?.created_at ?? null
      };
    })
  );

  return NextResponse.json({ employees });
}
