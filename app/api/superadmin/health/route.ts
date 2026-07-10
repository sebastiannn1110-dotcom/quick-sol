import { NextResponse } from "next/server";
import { requireSuperadmin, superadminConfigStatus } from "@/lib/superadmin/auth";
import { buildSuperadminHealth } from "@/lib/superadmin/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const health = await buildSuperadminHealth(context.service);
  return NextResponse.json({ health, superadmin: superadminConfigStatus() });
}
