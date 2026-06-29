import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { isMissingSchemaError, schemaErrorMetadata } from "@/lib/supabase/schema-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const REQUIRED_MIGRATION = "20260629000000_enterprise_mvp.sql";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext: LogContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: "GET"
  };

  await logger.info({
    ...logContext,
    module: "chat",
    action: "chat_users_load_started",
    message: "Chat user directory load started.",
    status: "started"
  });

  if (context.isDemoMode || !context.supabase) return NextResponse.json({ users: [context.profile] });
  const search = new URL(request.url).searchParams.get("q")?.trim().slice(0, 100) || null;
  const { data, error } = await context.supabase.rpc("list_chat_users", { search_text: search });
  if (error) {
    if (isMissingSchemaError(error)) {
      await logger.warn({
        ...logContext,
        module: "chat",
        action: "chat_users_rpc_missing_fallback",
        message: "Chat users RPC is missing; falling back to profiles select.",
        status: "failed",
        metadata: schemaErrorMetadata(error, REQUIRED_MIGRATION),
        error
      });
      const safeSearch = search?.replace(/[%,()]/g, " ").trim();
      const profilesQuery = context.supabase
        .from("profiles")
        .select("id,full_name,email,role,department,region,avatar_path,bio,job_title")
        .eq("is_active", true)
        .order("full_name")
        .limit(100);
      const { data: profiles, error: profilesError } = safeSearch
        ? await profilesQuery.or(`full_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%,department.ilike.%${safeSearch}%,region.ilike.%${safeSearch}%`)
        : await profilesQuery;
      if (profilesError) {
        await logger.error({
          ...logContext,
          module: "chat",
          action: "chat_users_profiles_fallback_failed",
          message: "Chat users profiles fallback failed.",
          status: "failed",
          error: profilesError
        });
        return NextResponse.json({ error: "No se pudo cargar el directorio del chat." }, { status: 500 });
      }
      return NextResponse.json({ users: profiles ?? [] });
    }

    await logger.error({
      ...logContext,
      module: "chat",
      action: "chat_users_load_failed",
      message: "Chat user directory load failed.",
      status: "failed",
      error
    });
    return NextResponse.json({ error: "No se pudo cargar el directorio del chat. Verifica la migracion empresarial." }, { status: 500 });
  }

  await logger.info({
    ...logContext,
    module: "chat",
    action: "chat_users_load_completed",
    message: "Chat user directory loaded.",
    status: "completed",
    metadata: { count: data?.length ?? 0 }
  });
  return NextResponse.json({ users: data ?? [] });
}
