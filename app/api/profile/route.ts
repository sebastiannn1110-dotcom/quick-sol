import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { isMissingSchemaError, missingMigrationMessage } from "@/lib/supabase/schema-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const profileUpdateSchema = z.object({
  bio: z.string().trim().max(500).optional().nullable(),
  job_title: z.string().trim().max(120).optional().nullable()
});

export async function PATCH(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const parsed = profileUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Revisa la descripcion y el cargo.", issues: parsed.error.flatten() }, { status: 400 });
  }

  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json({
      profile: {
        ...context.profile,
        bio: parsed.data.bio ?? null,
        job_title: parsed.data.job_title ?? null
      },
      demo: true
    });
  }

  const { data, error } = await context.supabase.rpc("update_my_profile_public", {
    new_bio: parsed.data.bio ?? null,
    new_job_title: parsed.data.job_title ?? null
  });

  if (error) {
    return NextResponse.json(
      { error: isMissingSchemaError(error) ? missingMigrationMessage("perfil de usuario") : "No se pudo actualizar tu perfil." },
      { status: isMissingSchemaError(error) ? 503 : 500 }
    );
  }

  await logAuditEvent(context, "profile_public_fields_updated", "profile", context.profile.id, {
    changed: ["bio", "job_title"]
  });

  return NextResponse.json({ profile: data });
}
