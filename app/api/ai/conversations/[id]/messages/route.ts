import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import {
  AI_MESSAGE_MAX_CHARACTERS,
  appendOwnedMessage,
  loadOwnedConversation
} from "@/lib/ai/conversation-memory";
import {
  conversationIdSchema,
  conversationMemoryErrorResponse,
  languageSchema,
  privateJson,
  readJsonBody,
  sourceTypeSchema
} from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const createMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(AI_MESSAGE_MAX_CHARACTERS),
    language: languageSchema.optional(),
    intent: z.string().trim().min(1).max(80).regex(/^[a-z0-9_.:-]+$/i).nullable().optional(),
    sourceType: sourceTypeSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "user" && value.sourceType && value.sourceType !== "user") {
      context.addIssue({
        code: "custom",
        path: ["sourceType"],
        message: "User messages must use sourceType=user."
      });
    }
    if (value.role === "assistant" && value.sourceType === "user") {
      context.addIssue({
        code: "custom",
        path: ["sourceType"],
        message: "Assistant messages cannot use sourceType=user."
      });
    }
  });

async function parseConversationId(routeContext: RouteContext) {
  const { id } = await routeContext.params;
  return conversationIdSchema.safeParse(id);
}

export async function GET(request: Request, routeContext: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const parsedId = await parseConversationId(routeContext);
  if (!parsedId.success) return privateJson({ error: "Conversation id must be a UUID." }, { status: 422 });
  try {
    const { messages, safeHistory } = await loadOwnedConversation(
      context.supabase,
      context.profile.id,
      parsedId.data
    );
    return privateJson({ messages, safeHistory });
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}

export async function POST(request: Request, routeContext: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (!context.supabase) return privateJson({ error: "AI conversation memory is unavailable." }, { status: 503 });

  const parsedId = await parseConversationId(routeContext);
  if (!parsedId.success) return privateJson({ error: "Conversation id must be a UUID." }, { status: 422 });
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = createMessageSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return privateJson({ error: "Invalid message request.", issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const message = await appendOwnedMessage(context.supabase, context.profile.id, parsedId.data, parsed.data);
    return privateJson({ message }, { status: 201 });
  } catch (error) {
    return conversationMemoryErrorResponse(error);
  }
}
