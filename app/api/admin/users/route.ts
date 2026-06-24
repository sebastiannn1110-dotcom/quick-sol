import { NextResponse } from "next/server";
import { z } from "zod";
import { logAuditEvent, requireAdmin } from "@/lib/auth/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getDemoPlatformData } from "@/lib/platform/demoRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateUserSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "manager", "employee"]).optional(),
  department: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  is_active: z.boolean().optional()
});

const inviteUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(1),
  role: z.enum(["admin", "manager", "employee"]).default("employee"),
  department: z.string().optional(),
  region: z.string().optional()
});

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

  const service = createSupabaseServiceRoleClient();
  if (!service) return NextResponse.json({ error: "Service role key is not configured." }, { status: 503 });

  const { data, error } = await service.auth.admin.inviteUserByEmail(body.data.email, {
    data: {
      full_name: body.data.full_name,
      role: body.data.role,
      department: body.data.department,
      region: body.data.region
    }
  });

  if (error) return NextResponse.json({ error: "Unable to invite user." }, { status: 500 });

  await logAuditEvent(context, "admin_user_created", "profile", data.user?.id ?? null, {
    email: body.data.email,
    role: body.data.role
  });

  return NextResponse.json({ user: data.user });
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

  if (!context.isDemoMode && body.data.role && body.data.role !== "admin") {
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
      return NextResponse.json({ error: "Cannot change the last active admin." }, { status: 400 });
    }
  }

  if (context.isDemoMode) {
    return NextResponse.json({ ok: true, demo: true });
  }

  const updatePayload = {
    ...(body.data.role ? { role: body.data.role } : {}),
    ...(body.data.department !== undefined ? { department: body.data.department } : {}),
    ...(body.data.region !== undefined ? { region: body.data.region } : {}),
    ...(body.data.is_active !== undefined ? { is_active: body.data.is_active } : {})
  };

  const { data, error } = await context.supabase!
    .from("profiles")
    .update(updatePayload)
    .eq("id", body.data.userId)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: "Unable to update user." }, { status: 500 });

  await logAuditEvent(
    context,
    body.data.role ? "admin_role_changed" : body.data.is_active === false ? "admin_user_deactivated" : "admin_user_updated",
    "profile",
    body.data.userId,
    updatePayload
  );

  return NextResponse.json({ user: data });
}
