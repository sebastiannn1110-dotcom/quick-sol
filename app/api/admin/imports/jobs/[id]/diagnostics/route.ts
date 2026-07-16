import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { getImportJobDiagnostics } from "@/lib/upload/job-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ error: "Supabase is required." }, { status: 503 });

  const { id } = await params;
  const diagnostics = await getImportJobDiagnostics(context.supabase, id);
  if (!diagnostics) return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  return NextResponse.json({ diagnostics });
}
