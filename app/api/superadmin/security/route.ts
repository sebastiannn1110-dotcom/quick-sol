import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadmin/auth";
import { buildSuperadminSecurity } from "@/lib/superadmin/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const security = await buildSuperadminSecurity(context.service);
  return NextResponse.json({ security });
}
