import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ events: [] });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const eventType = searchParams.get("eventType");
  const limit = Math.min(Number(searchParams.get("limit") || 100), 200);

  let query = context.supabase
    .from("email_notification_events")
    .select("*, email_alert_rules(name,event_type)")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);
  if (eventType) query = query.eq("event_type", eventType);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Unable to load email event history." }, { status: 500 });
  return NextResponse.json({ events: data ?? [] });
}
