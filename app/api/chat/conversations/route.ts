import { NextResponse } from "next/server";
import { getAuthContext, logAuditEvent } from "@/lib/auth/context";
import { canCreateChatGroup } from "@/lib/chat/chat-permissions";
import { conversationSchema } from "@/lib/chat/chat-service";
import type { LogContext } from "@/lib/logger/types";
import { logger } from "@/lib/logger/logger";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { isMissingSchemaError, missingMigrationMessage, schemaErrorMetadata } from "@/lib/supabase/schema-errors";

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
    action: "chat_conversations_load_started",
    message: "Chat conversations load started.",
    status: "started"
  });

  if (context.isDemoMode || !context.supabase) return NextResponse.json({ conversations: [] });

  const { data: memberRows, error: memberError } = await context.supabase
    .from("chat_conversation_members")
    .select("conversation_id")
    .eq("user_id", context.profile.id);

  if (memberError) {
    await logger.error({
      ...logContext,
      module: "chat",
      action: "chat_conversations_membership_load_failed",
      message: "Chat conversation membership load failed.",
      status: "failed",
      metadata: isMissingSchemaError(memberError) ? schemaErrorMetadata(memberError, REQUIRED_MIGRATION) : undefined,
      error: memberError
    });
    return NextResponse.json(
      { error: isMissingSchemaError(memberError) ? missingMigrationMessage("chat interno") : "No se pudieron cargar tus conversaciones." },
      { status: isMissingSchemaError(memberError) ? 503 : 500 }
    );
  }

  const conversationIds = Array.from(new Set((memberRows ?? []).map((member) => member.conversation_id).filter(Boolean)));
  if (!conversationIds.length) {
    await logger.info({
      ...logContext,
      module: "chat",
      action: "chat_conversations_load_completed",
      message: "Chat conversations loaded.",
      status: "completed",
      metadata: { conversationCount: 0 }
    });
    return NextResponse.json({ conversations: [] });
  }

  const { data: conversations, error } = await context.supabase
    .from("chat_conversations")
    .select("id, type, name, description, created_by, created_at, updated_at, chat_conversation_members(id,user_id,role,joined_at,last_read_at)")
    .in("id", conversationIds)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    await logger.error({
      ...logContext,
      module: "chat",
      action: "chat_conversations_load_failed",
      message: "Chat conversations load failed.",
      status: "failed",
      metadata: isMissingSchemaError(error) ? schemaErrorMetadata(error, REQUIRED_MIGRATION) : undefined,
      error
    });
    return NextResponse.json(
      { error: isMissingSchemaError(error) ? missingMigrationMessage("chat interno") : "No se pudieron cargar las conversaciones. Verifica la migracion empresarial." },
      { status: isMissingSchemaError(error) ? 503 : 500 }
    );
  }

  const ids = (conversations ?? []).map((conversation) => conversation.id);
  const [messagesResult, usersResult] = await Promise.all([
    ids.length
      ? context.supabase.from("chat_messages").select("id, conversation_id, sender_id, body, message_type, created_at").in("conversation_id", ids).is("deleted_at", null).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [], error: null }),
    context.supabase.rpc("list_chat_users", { search_text: null })
  ]);
  if (messagesResult.error || usersResult.error) {
    const failure = messagesResult.error ?? usersResult.error;
    await logger.error({
      ...logContext,
      module: "chat",
      action: "chat_conversations_enrichment_failed",
      message: "Chat conversations enrichment failed.",
      status: "failed",
      metadata: failure && isMissingSchemaError(failure) ? schemaErrorMetadata(failure, REQUIRED_MIGRATION) : { conversationCount: ids.length },
      error: failure
    });
    return NextResponse.json(
      { error: failure && isMissingSchemaError(failure) ? missingMigrationMessage("chat interno") : "No se pudieron preparar las conversaciones." },
      { status: failure && isMissingSchemaError(failure) ? 503 : 500 }
    );
  }
  const users = new Map((usersResult.data ?? []).map((user: { id: string }) => [user.id, user]));
  const latestByConversation = new Map<string, unknown>();
  for (const message of messagesResult.data ?? []) if (!latestByConversation.has(message.conversation_id)) latestByConversation.set(message.conversation_id, message);

  const enriched = (conversations ?? []).map((conversation) => ({
    ...conversation,
    members: conversation.chat_conversation_members.map((member) => ({ ...member, profile: users.get(member.user_id) ?? null })),
    latestMessage: latestByConversation.get(conversation.id) ?? null
  }));
  await logger.info({
    ...logContext,
    module: "chat",
    action: "chat_conversations_load_completed",
    message: "Chat conversations loaded.",
    status: "completed",
    metadata: { conversationCount: enriched.length }
  });
  return NextResponse.json({ conversations: enriched });
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  const logContext: LogContext = {
    traceId: context.requestMeta.traceId,
    requestId: context.requestMeta.requestId,
    userId: context.profile.id,
    userEmail: context.profile.email,
    userRole: context.profile.role,
    route: context.requestMeta.route,
    method: "POST"
  };

  await logger.info({
    ...logContext,
    module: "chat",
    action: "chat_conversation_create_started",
    message: "Chat conversation creation started.",
    status: "started"
  });

  try {
    const parsed = conversationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      await logger.warn({
        ...logContext,
        module: "chat",
        action: "chat_conversation_validation_failed",
        message: "Chat conversation validation failed.",
        status: "failed",
        metadata: parsed.error.flatten()
      });
      return NextResponse.json({ error: "Revisa el tipo de chat y los participantes.", issues: parsed.error.flatten() }, { status: 400 });
    }
    if (parsed.data.type === "group" && !canCreateChatGroup(context.profile.role)) {
      await logger.security({
        ...logContext,
        module: "chat",
        action: "chat_group_create_denied",
        message: "Non-admin user attempted to create a chat group.",
        status: "failed",
        metadata: { type: parsed.data.type }
      });
      return NextResponse.json({ error: "Solo un administrador puede crear grupos." }, { status: 403 });
    }
    if (context.isDemoMode || !context.supabase) return NextResponse.json({ conversationId: crypto.randomUUID(), demo: true });

    const rate = await checkPersistentRateLimit({ action: "chat_create_conversation", identifier: context.profile.id, limit: 20, windowSeconds: 60 * 60 });
    if (!rate.allowed) {
      await logger.security({
        ...logContext,
        module: "security",
        action: "chat_conversation_create_rate_limited",
        message: "Chat conversation creation rate limit was triggered.",
        status: "failed",
        metadata: { resetAt: rate.resetAt, persistent: rate.persistent }
      });
      return rateLimitResponse(rate.resetAt);
    }
    const { data, error } = await context.supabase.rpc("create_chat_conversation", {
      conversation_type: parsed.data.type,
      conversation_name: parsed.data.name ?? "",
      conversation_description: parsed.data.description ?? "",
      participant_ids: parsed.data.participantIds
    });
    if (error) {
      await logger.error({
        ...logContext,
        module: "chat",
        action: "chat_conversation_create_failed",
        message: "Chat conversation creation failed.",
        status: "failed",
        metadata: isMissingSchemaError(error)
          ? schemaErrorMetadata(error, REQUIRED_MIGRATION)
          : { type: parsed.data.type, participantCount: parsed.data.participantIds.length },
        error
      });
      return NextResponse.json(
        {
          error: isMissingSchemaError(error) ? missingMigrationMessage("chat interno") : "No se pudo crear la conversacion.",
          detail: error.message
        },
        { status: isMissingSchemaError(error) ? 503 : 500 }
      );
    }
    await logAuditEvent(context, "chat_conversation_created", "chat_conversation", data, { type: parsed.data.type, participantCount: parsed.data.participantIds.length });
    await logger.info({
      ...logContext,
      module: "chat",
      action: "chat_conversation_create_completed",
      message: "Chat conversation created.",
      status: "completed",
      metadata: { conversationId: data, type: parsed.data.type, participantCount: parsed.data.participantIds.length }
    });
    return NextResponse.json({ conversationId: data });
  } catch (error) {
    await logger.error({
      ...logContext,
      module: "chat",
      action: "chat_conversation_create_failed",
      message: "Chat conversation creation failed unexpectedly.",
      status: "failed",
      error
    });
    return NextResponse.json({ error: "No se pudo crear la conversacion." }, { status: 500 });
  }
}
