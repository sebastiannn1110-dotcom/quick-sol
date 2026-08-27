import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";
import { isSuperAdminDev } from "@/lib/auth/roles";
import type { UserRole } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const managedRoleSchema = z.enum(["admin", "manager", "employee", "super_admin_dev"]);

const updateUserSchema = z.object({
  userId: z.string().uuid(),
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: managedRoleSchema.optional(),
  department: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  job_title: z.string().trim().max(120).nullable().optional(),
  is_active: z.boolean().optional(),
  confirmSelfDeactivate: z.boolean().optional()
});

const inviteUserSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  full_name: z.string().trim().min(1),
  role: managedRoleSchema.default("employee"),
  department: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  bio: z.string().trim().max(500).nullable().optional(),
  job_title: z.string().trim().max(120).nullable().optional(),
  password: z.string().min(8).optional()
});

const serviceRoleMessage =
  "Server admin access is not configured. Please add SUPABASE_SERVICE_ROLE_KEY in Render environment variables.";
const lastEffectiveAdminSqlState = "QS821";
const lastEffectiveAdminPublicCode = "LAST_EFFECTIVE_ADMIN_REQUIRED";
const adminMutationForbiddenSqlState = "42501";
const adminMutationForbiddenPublicCode = "ADMIN_MUTATION_FORBIDDEN";

function adminMutationErrorResponse(error: { code?: string | null } | null, fallbackMessage: string) {
  if (error?.code === lastEffectiveAdminSqlState) {
    return NextResponse.json(
      {
        error: "At least one effective administrator must remain.",
        code: lastEffectiveAdminPublicCode
      },
      { status: 409 }
    );
  }
  if (error?.code === adminMutationForbiddenSqlState) {
    return NextResponse.json(
      {
        error: "You do not have permission to perform this administrative change.",
        code: adminMutationForbiddenPublicCode
      },
      { status: 403 }
    );
  }

  return NextResponse.json({ error: fallbackMessage }, { status: 500 });
}

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
  if (body.data.role === "super_admin_dev" && !isSuperAdminDev(context.profile.role)) {
    return NextResponse.json({ error: "Only Super Admin Dev can create a Super Admin Dev profile." }, { status: 403 });
  }

  if (context.isDemoMode) {
    return NextResponse.json({ error: "Configure Supabase service role to invite users." }, { status: 503 });
  }

  const service = createSupabaseAdminClient();
  if (!service) return NextResponse.json({ error: serviceRoleMessage }, { status: 503 });

  const { data: intentId, error: intentError } = await context.supabase!.rpc(
    "create_user_provisioning_intent_v1",
    {
      requested_email: body.data.email,
      requested_full_name: body.data.full_name,
      requested_role: body.data.role,
      requested_department: body.data.department ?? null,
      requested_region: body.data.region ?? null,
      requested_is_active: true,
      requested_bio: body.data.bio ?? null,
      requested_job_title: body.data.job_title ?? null
    }
  );

  if (intentError) {
    if (intentError.code === adminMutationForbiddenSqlState) {
      return NextResponse.json(
        {
          error: "You do not have permission to provision this user.",
          code: adminMutationForbiddenPublicCode
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: "Unable to prepare user creation." }, { status: 500 });
  }
  if (typeof intentId !== "string" || !z.string().uuid().safeParse(intentId).success) {
    return NextResponse.json({ error: "Unable to prepare user creation." }, { status: 500 });
  }

  const password = body.data.password ?? temporaryPassword();
  const { data, error } = await service.auth.admin.createUser({
    email: body.data.email,
    password,
    email_confirm: true,
    // GoTrue can persist custom app_metadata after the initial auth.users
    // INSERT, so the trigger needs this opaque locator in user_metadata.
    user_metadata: {
      full_name: body.data.full_name,
      quiksol_provisioning_intent_id: intentId
    }
  });

  if (error || !data.user) return NextResponse.json({ error: "Unable to create user." }, { status: 500 });

  // createUser only commits after the auth.users trigger has inserted this
  // exact final profile and completed the one-use intent.
  const profile = {
    id: data.user.id,
    full_name: body.data.full_name,
    email: body.data.email,
    role: body.data.role,
    department: body.data.department ?? null,
    region: body.data.region ?? null,
    bio: body.data.bio ?? null,
    job_title: body.data.job_title ?? null,
    is_active: true
  };

  await logAuditEvent(
    context,
    body.data.role === "super_admin_dev" ? "superadmin_created_privileged_user" : "admin_created_employee",
    "profile",
    data.user.id,
    {
    email: body.data.email,
    role: body.data.role
    }
  );

  return NextResponse.json({ user: profile, temporaryPassword: password });
}

export async function PATCH(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  const body = updateUserSchema.safeParse(await request.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.issues.map((issue) => issue.message).join(" ") }, { status: 400 });
  }
  if (body.data.role === "super_admin_dev" && !isSuperAdminDev(context.profile.role)) {
    return NextResponse.json({ error: "Only Super Admin Dev can promote a profile to Super Admin Dev." }, { status: 403 });
  }

  if (body.data.userId === context.profile.id && isSuperAdminDev(context.profile.role) && body.data.role) {
    return NextResponse.json({ error: "Super Admin Dev role cannot be changed from the admin screen." }, { status: 403 });
  }
  if (body.data.userId === context.profile.id && body.data.role && body.data.role !== "admin") {
    return NextResponse.json({ error: "Admins cannot demote themselves from this screen." }, { status: 400 });
  }
  if (body.data.userId === context.profile.id && body.data.is_active === false && !body.data.confirmSelfDeactivate) {
    return NextResponse.json({ error: "Self deactivation requires explicit confirmation." }, { status: 400 });
  }

  let targetRole: UserRole | null = null;
  if (!context.isDemoMode) {
    const target = await context.supabase!
      .from("profiles")
      .select("role")
      .eq("id", body.data.userId)
      .single();
    if (target.error || !target.data) return NextResponse.json({ error: "User profile not found." }, { status: 404 });
    targetRole = target.data.role as UserRole;
    if (isSuperAdminDev(targetRole) && !isSuperAdminDev(context.profile.role)) {
      return NextResponse.json({ error: "Only Super Admin Dev can modify a Super Admin Dev profile." }, { status: 403 });
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
    ...(body.data.bio !== undefined ? { bio: body.data.bio } : {}),
    ...(body.data.job_title !== undefined ? { job_title: body.data.job_title } : {}),
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

  const { data, error } = await context.supabase!.rpc("update_profile_admin_v2", {
    target_profile_id: body.data.userId,
    profile_patch: updatePayload,
    confirm_self_deactivate: body.data.confirmSelfDeactivate === true
  });

  if (error) return adminMutationErrorResponse(error, "Unable to update user.");

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
    if (isSuperAdminDev(target.data?.role)) {
      return NextResponse.json({ error: "Super Admin Dev cannot be deactivated from the admin screen." }, { status: 403 });
    }
  }

  if (context.isDemoMode) return NextResponse.json({ ok: true, demo: true });

  const { error } = await context.supabase!.rpc("update_profile_admin_v2", {
    target_profile_id: body.data.userId,
    profile_patch: { is_active: false },
    confirm_self_deactivate: false
  });
  if (error) return adminMutationErrorResponse(error, "Unable to deactivate user.");

  await logAuditEvent(context, "admin_deactivated_employee", "profile", body.data.userId, { softDelete: true });
  return NextResponse.json({ ok: true });
}
