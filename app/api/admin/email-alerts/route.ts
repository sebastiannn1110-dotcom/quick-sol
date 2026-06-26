import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { getEmailProvider } from "@/lib/email/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ruleSchema = z.object({
  name: z.string().trim().min(2).max(120),
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
  ]),
  condition_type: z.string().trim().max(80).optional().nullable(),
  condition_value: z.number().nullable().optional(),
  recipients: z.array(z.string().email()).min(1).max(25),
  enabled: z.boolean().default(true),
  frequency: z.enum(["immediate", "daily", "weekly"]).default("immediate")
});

function isMissingEmailTables(error: { code?: string; message?: string } | null) {
  return Boolean(
    error &&
      (error.code === "42P01" ||
        error.message?.includes("email_alert_rules") ||
        error.message?.includes("does not exist"))
  );
}

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ rules: [], provider: getEmailProvider() });

  const { data, error } = await context.supabase
    .from("email_alert_rules")
    .select("*, profiles(full_name,email)")
    .order("created_at", { ascending: false });

  if (isMissingEmailTables(error)) {
    return NextResponse.json({
      rules: [],
      provider: getEmailProvider(),
      setupRequired: true,
      error: "Email alert tables are missing. Run supabase/migrations/20260626010000_email_alerts.sql in Supabase."
    });
  }
  if (error) return NextResponse.json({ rules: [], provider: getEmailProvider(), error: "Unable to load email alert rules." }, { status: 500 });
  return NextResponse.json({ rules: data ?? [], provider: getEmailProvider() });
}

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const body = await request.json().catch(() => null);
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid email alert rule.", issues: parsed.error.flatten() }, { status: 400 });
  if (context.isDemoMode || !context.supabase) return NextResponse.json({ rule: { id: crypto.randomUUID(), ...parsed.data }, demo: true });

  const { data, error } = await context.supabase
    .from("email_alert_rules")
    .insert({ ...parsed.data, created_by: context.profile.id })
    .select("*")
    .single();

  if (isMissingEmailTables(error)) {
    return NextResponse.json({
      error: "Email alert tables are missing. Run supabase/migrations/20260626010000_email_alerts.sql in Supabase.",
      setupRequired: true
    }, { status: 503 });
  }
  if (error) return NextResponse.json({ error: "Unable to create email alert rule." }, { status: 500 });
  await logAuditEvent(context, "email_alert_rule_created", "email_alert_rule", data.id, { eventType: data.event_type });
  return NextResponse.json({ rule: data });
}
