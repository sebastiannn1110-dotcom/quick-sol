import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  event_type: z.enum([
    "upload_completed",
    "upload_failed",
    "upload_has_many_errors",
    "low_gp_rate",
    "missing_mpn_threshold",
    "weekly_report",
    "new_dataset_published",
    "import_quality_below_threshold"
  ]).optional(),
  condition_type: z.string().trim().max(80).optional().nullable(),
  condition_value: z.number().nullable().optional(),
  recipients: z.array(z.string().email()).min(1).max(25).optional(),
  enabled: z.boolean().optional(),
  frequency: z.enum(["immediate", "daily", "weekly"]).optional()
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid email alert rule update.", issues: parsed.error.flatten() }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const { data, error } = await context.supabase
    .from("email_alert_rules")
    .update(parsed.data)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: "Unable to update email alert rule." }, { status: 500 });
  await logAuditEvent(context, "email_alert_rule_updated", "email_alert_rule", id, { eventType: data.event_type });
  return NextResponse.json({ rule: data });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const { id } = await params;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ ok: true, demo: true });

  const { error } = await context.supabase
    .from("email_alert_rules")
    .update({ enabled: false })
    .eq("id", id);

  if (error) return NextResponse.json({ error: "Unable to disable email alert rule." }, { status: 500 });
  await logAuditEvent(context, "email_alert_rule_disabled", "email_alert_rule", id);
  return NextResponse.json({ ok: true });
}
