import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import {
  loadOwnedConversation,
  softDeleteOwnedConversation
} from "@/lib/ai/conversation-memory";
import {
  conversationIdSchema,
  conversationMemoryErrorResponse,
  privateJson
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function ownedId(context: RouteContext) {
  const { id } = await context.params;
  return conversationIdSchema.safeParse(id);
}

export async function GET(request: Request, routeContext: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const parsedId = await ownedId(routeContext);
  if (!parsedId.success) return privateJson({ error: "Conversation id must be a UUID." }, { status: 422 });
  try {
    const result = await loadOwnedConversation(context.supabase, context.profile.id, parsedId.data);
    return privateJson(result);
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}

export async function DELETE(request: Request, routeContext: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const parsedId = await ownedId(routeContext);
  if (!parsedId.success) return privateJson({ error: "Conversation id must be a UUID." }, { status: 422 });
  try {
    const deleted = await softDeleteOwnedConversation(context.supabase, context.profile.id, parsedId.data);
    if (!deleted) return privateJson({ error: "Conversation not found.", code: "not_found" }, { status: 404 });
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store, max-age=0" }
    });
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}
