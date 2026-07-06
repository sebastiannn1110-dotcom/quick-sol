import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { getEmailProviderDiagnostics } from "@/lib/email/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const diagnostics = getEmailProviderDiagnostics();
  console.info("admin_email_debug_requested", {
    adminUserId: context.profile.id,
    provider: diagnostics.provider,
    hasResendApiKey: diagnostics.hasResendApiKey,
    hasSmtpConfig: diagnostics.hasSmtpConfig,
    emailFrom: diagnostics.emailFrom,
    canSendRealEmail: diagnostics.canSendRealEmail,
    warnings: diagnostics.warnings
  });

  return NextResponse.json(diagnostics);
}
