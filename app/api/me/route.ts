import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  return NextResponse.json({
    profile: context.profile,
    isDemoMode: context.isDemoMode
  });
}
