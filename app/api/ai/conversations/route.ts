import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import {
  AI_CONVERSATION_RETENTION_DAYS,
  AI_CONVERSATION_TITLE_MAX_CHARACTERS,
  ConversationMemoryError,
  createOwnedConversation,
  listOwnedConversations
} from "@/lib/ai/conversation-memory";
import {
  conversationMemoryErrorResponse,
  languageSchema,
  privateJson,
  readJsonBody
} from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(AI_CONVERSATION_TITLE_MAX_CHARACTERS).optional(),
    language: languageSchema.optional(),
    retentionDays: z.number().int().min(1).max(AI_CONVERSATION_RETENTION_DAYS).optional()
  })
  .strict();

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) {
    return privateJson({ conversations: [], persistenceAvailable: false });
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 30;
  try {
    const conversations = await listOwnedConversations(context.supabase, context.profile.id, limit);
    return privateJson({ conversations, persistenceAvailable: true });
  } catch (error) {
    if (error instanceof ConversationMemoryError && error.code === "migration_required") {
      return privateJson({ conversations: [], persistenceAvailable: false });
    }
    return conversationMemoryErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createConversationSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return privateJson({ error: "Invalid conversation request.", issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const conversation = await createOwnedConversation(context.supabase, context.profile.id, parsed.data);
    return privateJson({ conversation }, { status: 201 });
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}
