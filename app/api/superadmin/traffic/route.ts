import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadmin/auth";
import { buildTrafficAnalytics } from "@/lib/traffic/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireSuperadmin(request);
  if (context instanceof NextResponse) return context;
  const range = new URL(request.url).searchParams.get("range");
  const traffic = await buildTrafficAnalytics(context.service, range);
  return NextResponse.json({ traffic });
}
