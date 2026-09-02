import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { sendEmail } from "@/lib/email/email-service";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { visibleEmailAddress } from "@/lib/auth/demo-login";

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
  const rate = await checkPersistentRateLimit({ action: "email_alert_test", identifier: context.profile.id, limit: 12, windowSeconds: 60 * 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const subject = parsed.data.subject || "[Electronic Parts] Email alerts test";
  const result = await sendEmail({
    to: parsed.data.recipients,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif">
        <h2>Electronic Parts email alerts test</h2>
        <p>This confirms that the configured provider can process Electronic Parts alert emails.</p>
        <p>Requested by ${context.profile.full_name} (${visibleEmailAddress(context.profile.email, context.profile.full_name)}).</p>
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
          metadata: { provider: result.provider, requestedBy: visibleEmailAddress(context.profile.email, context.profile.full_name) },
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
