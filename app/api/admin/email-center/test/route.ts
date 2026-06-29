import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { adminMessageHtml } from "@/lib/email/content";
import { sendEmail } from "@/lib/email/email-service";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().email().max(254) });

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Escribe un correo valido." }, { status: 400 });
  const rate = await checkPersistentRateLimit({ action: "admin_email_test", identifier: context.profile.id, limit: 10, windowSeconds: 60 * 60 });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);
  const result = await sendEmail({
    to: [parsed.data.email],
    subject: "[Quiksol] Prueba del centro de correo",
    html: adminMessageHtml({ subject: "El correo de Quiksol funciona", body: "Esta prueba confirma que el proveedor configurado puede enviar mensajes desde el centro administrativo.", senderName: context.profile.full_name })
  });
  await logAuditEvent(context, "admin_email_test", "admin_email_message", null, { recipient: parsed.data.email, provider: result.provider, status: result.status });
  return NextResponse.json({ result });
}
