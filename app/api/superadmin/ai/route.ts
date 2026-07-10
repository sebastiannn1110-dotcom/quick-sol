import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadmin/auth";
import { buildSuperadminAi } from "@/lib/superadmin/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const ai = await buildSuperadminAi(context.service);
  return NextResponse.json({ ai });
}
