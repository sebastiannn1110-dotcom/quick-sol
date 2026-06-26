import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { sendEmail } from "@/lib/email/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({
  recipients: z.array(z.string().email()).min(1).max(10),
  subject: z.string().trim().min(2).max(160).optional()
});

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const body = await request.json().catch(() => null);
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid test email request.", issues: parsed.error.flatten() }, { status: 400 });

  const subject = parsed.data.subject || "[Quiksol] Email alerts test";
  const result = await sendEmail({
    to: parsed.data.recipients,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif">
        <h2>Quiksol email alerts test</h2>
        <p>This confirms that the configured provider can process Quiksol alert emails.</p>
        <p>Requested by ${context.profile.full_name} (${context.profile.email}).</p>
      </div>
    `
  });

  if (!context.isDemoMode && context.supabase) {
    await Promise.all(
      parsed.data.recipients.map((recipient) =>
        context.supabase!.from("email_notification_events").insert({
          event_type: "test_email",
          recipient,
          subject,
          status: result.status,
          error_message: result.errorMessage ?? null,
          metadata: { provider: result.provider, requestedBy: context.profile.email },
          sent_at: result.status === "sent" ? new Date().toISOString() : null
        })
      )
    );
  }

  await logAuditEvent(context, "email_alert_test_sent", "email_notification_event", null, {
    recipients: parsed.data.recipients,
    provider: result.provider,
    status: result.status
  });

  return NextResponse.json({ result });
}
