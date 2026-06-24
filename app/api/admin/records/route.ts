import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { recordsFilterSchema } from "@/lib/excel/validators";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const { searchParams } = new URL(request.url);
  const filters = recordsFilterSchema.parse(Object.fromEntries(searchParams.entries()));
  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    return NextResponse.json({
      records: data.records.slice(from, to + 1),
      count: data.records.length,
      page: filters.page,
      pageSize: filters.pageSize
    });
  }

  const { data, error, count } = await context.supabase!
    .from("business_records")
    .select("*, profiles(full_name,email,department,region,role), upload_batches(original_file_name,detected_category,status)", {
      count: "exact"
    })
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: "Unable to load admin records." }, { status: 500 });
  return NextResponse.json({
    records: data ?? [],
    count: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize
  });
}
