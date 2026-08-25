import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { softDeleteOwnedMessage } from "@/lib/ai/conversation-memory";
import {
  conversationIdSchema,
  conversationMemoryErrorResponse,
  privateJson
} from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; messageId: string }> };

export async function DELETE(request: Request, routeContext: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const { id, messageId } = await routeContext.params;
  const parsedConversationId = conversationIdSchema.safeParse(id);
  const parsedMessageId = conversationIdSchema.safeParse(messageId);
  if (!parsedConversationId.success || !parsedMessageId.success) {
    return privateJson({ error: "Conversation and message ids must be UUIDs." }, { status: 422 });
  }

  try {
    const deleted = await softDeleteOwnedMessage(
      context.supabase,
      context.profile.id,
      parsedConversationId.data,
      parsedMessageId.data
    );
    if (!deleted) return privateJson({ error: "Message not found.", code: "not_found" }, { status: 404 });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store, max-age=0" }
    });
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}
