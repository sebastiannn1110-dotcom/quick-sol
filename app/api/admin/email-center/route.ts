import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { getEmailProvider } from "@/lib/email/email-service";
import { EMAIL_TEMPLATES } from "@/lib/email/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function missingTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("admin_email_messages")));
}

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({ employees: [], history: [], provider: getEmailProvider(), templates: EMAIL_TEMPLATES, demo: true });
  }

  const [profilesResult, historyResult] = await Promise.all([
    context.supabase
      .from("profiles")
      .select("id, full_name, email, role, department, region, avatar_path")
      .eq("is_active", true)
      .order("full_name")
      .limit(500),
    context.supabase
      .from("admin_email_messages")
      .select("id, subject, sender_user_id, recipients, recipient_count, status, provider, error_message, metadata, created_at, sent_at")
      .order("created_at", { ascending: false })
      .limit(50)
  ]);

  if (missingTable(historyResult.error)) {
    return NextResponse.json({
      employees: profilesResult.data ?? [],
      history: [],
      provider: getEmailProvider(),
      templates: EMAIL_TEMPLATES,
      setupRequired: true,
      error: "Ejecuta la migracion 20260629000000_enterprise_mvp.sql en Supabase."
    });
  }
  if (profilesResult.error || historyResult.error) return NextResponse.json({ error: "No se pudo cargar el centro de correo." }, { status: 500 });

  return NextResponse.json({
    employees: profilesResult.data ?? [],
    history: historyResult.data ?? [],
    provider: getEmailProvider(),
    templates: EMAIL_TEMPLATES
  });
}
