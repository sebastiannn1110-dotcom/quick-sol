import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required for import jobs." }, { status: 503 });

  const { data: job, error } = await context.supabase
    .from("import_jobs")
    .select("*, upload_batches(*)")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load import job." }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  return NextResponse.json({ job, upload: job.upload_batches });
}
