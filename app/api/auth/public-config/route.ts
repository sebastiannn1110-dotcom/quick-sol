import { NextResponse } from "next/server";
import { getSupabasePublishableKey } from "@/lib/security/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabasePublishableKey = getSupabasePublishableKey();

  return NextResponse.json({
    configured: Boolean(supabaseUrl && supabasePublishableKey),
    supabaseUrl,
    supabasePublishableKey
  });
}
