import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateUserSchema = z.object({
  userId: z.string().uuid(),
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["admin", "manager", "employee"]).optional(),
  department: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  confirmSelfDeactivate: z.boolean().optional()
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  role: z.enum(["admin", "manager", "employee"]).default("employee"),
  department: z.string().optional(),
  region: z.string().optional(),
  password: z.string().min(8).optional()
});

const serviceRoleMessage =
  "Server admin access is not configured. Please add SUPABASE_SERVICE_ROLE_KEY in Render environment variables.";

function temporaryPassword() {
  return `Quiksol-${crypto.randomUUID().slice(0, 8)}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  if (context.isDemoMode) {
    const data = await getDemoPlatformData();
    return NextResponse.json({ users: data.profiles });
  }

  const { data, error } = await context.supabase!.from("profiles").select("*").order("created_at", {
    ascending: false
  });

  if (error) return NextResponse.json({ error: "Unable to load users." }, { status: 500 });
  return NextResponse.json({ users: data ?? [] });
}

export async function POST(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const body = inviteUserSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
  }

  if (context.isDemoMode) {
    return NextResponse.json({ error: "Configure Supabase service role to invite users." }, { status: 503 });
  }

  const service = createSupabaseAdminClient();
  if (!service) return NextResponse.json({ error: serviceRoleMessage }, { status: 503 });

  const password = body.data.password ?? temporaryPassword();
  const { data, error } = await service.auth.admin.createUser({
    email: body.data.email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: body.data.full_name,
      role: body.data.role,
      department: body.data.department,
      region: body.data.region
    }
  });

  if (error || !data.user) return NextResponse.json({ error: "Unable to create user." }, { status: 500 });

  const { data: profile, error: profileError } = await service
    .from("profiles")
    .upsert({
      id: data.user.id,
      full_name: body.data.full_name,
      email: body.data.email,
      role: body.data.role,
      department: body.data.department ?? null,
      region: body.data.region ?? null,
      is_active: true
    })
    .select("*")
    .single();

  if (profileError) return NextResponse.json({ error: "User was created, but profile could not be saved." }, { status: 500 });

  await logAuditEvent(context, "admin_created_employee", "profile", data.user.id, {
    email: body.data.email,
    role: body.data.role
  });

  return NextResponse.json({ user: profile, temporaryPassword: password });
}

export async function PATCH(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const body = updateUserSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
  }

  if (body.data.userId === context.profile.id && body.data.role && body.data.role !== "admin") {
    return NextResponse.json({ error: "Admins cannot demote themselves from this screen." }, { status: 400 });
  }
  if (body.data.userId === context.profile.id && body.data.is_active === false && !body.data.confirmSelfDeactivate) {
    return NextResponse.json({ error: "Self deactivation requires explicit confirmation." }, { status: 400 });
  }

  if (!context.isDemoMode && ((body.data.role && body.data.role !== "admin") || body.data.is_active === false)) {
    const { count } = await context.supabase!
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_active", true);

    const target = await context.supabase!
      .from("profiles")
      .select("role")
      .eq("id", body.data.userId)
      .single();

    if ((count ?? 0) <= 1 && target.data?.role === "admin") {
      return NextResponse.json({ error: "Cannot deactivate or demote the last active admin." }, { status: 400 });
    }
  }

  if (context.isDemoMode) {
    return NextResponse.json({ ok: true, demo: true });
  }

  const updatePayload = {
    ...(body.data.full_name ? { full_name: body.data.full_name } : {}),
    ...(body.data.email ? { email: body.data.email } : {}),
    ...(body.data.role ? { role: body.data.role } : {}),
    ...(body.data.department !== undefined ? { department: body.data.department } : {}),
    ...(body.data.region !== undefined ? { region: body.data.region } : {}),
    ...(body.data.is_active !== undefined ? { is_active: body.data.is_active } : {})
  };

  if (body.data.email) {
    const service = createSupabaseAdminClient();
    if (!service) return NextResponse.json({ error: serviceRoleMessage }, { status: 503 });
    const { error: authUpdateError } = await service.auth.admin.updateUserById(body.data.userId, {
      email: body.data.email
    });
    if (authUpdateError) return NextResponse.json({ error: "Unable to update auth email." }, { status: 500 });
  }

  const { data, error } = await context.supabase!
    .from("profiles")
    .update(updatePayload)
    .eq("id", body.data.userId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: "Unable to update user." }, { status: 500 });

  const auditActions: string[] = [];
  if (body.data.full_name) auditActions.push("admin_renamed_employee");
  if (body.data.role) auditActions.push("admin_changed_role");
  if (body.data.is_active === false) auditActions.push("admin_deactivated_employee");
  if (body.data.is_active === true) auditActions.push("admin_reactivated_employee");
  if (!auditActions.length) auditActions.push("admin_updated_employee");

  for (const action of auditActions) {
    await logAuditEvent(context, action, "profile", body.data.userId, updatePayload);
  }

  return NextResponse.json({ user: data });
}

export async function DELETE(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const body = z.object({ userId: z.string().uuid() }).safeParse(await request.json());
  if (!body.success) return NextResponse.json({ error: "Invalid user id." }, { status: 400 });
  if (body.data.userId === context.profile.id) {
    return NextResponse.json({ error: "Use deactivate with explicit confirmation for your own account." }, { status: 400 });
  }

  if (!context.isDemoMode) {
    const target = await context.supabase!.from("profiles").select("role").eq("id", body.data.userId).single();
    if (target.data?.role === "admin") {
      const { count } = await context.supabase!
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "admin")
        .eq("is_active", true);
      if ((count ?? 0) <= 1) return NextResponse.json({ error: "Cannot deactivate the last active admin." }, { status: 400 });
    }
  }

  if (context.isDemoMode) return NextResponse.json({ ok: true, demo: true });

  const { error } = await context.supabase!.from("profiles").update({ is_active: false }).eq("id", body.data.userId);
  if (error) return NextResponse.json({ error: "Unable to deactivate user." }, { status: 500 });

  await logAuditEvent(context, "admin_deactivated_employee", "profile", body.data.userId, { softDelete: true });
  return NextResponse.json({ ok: true });
}
