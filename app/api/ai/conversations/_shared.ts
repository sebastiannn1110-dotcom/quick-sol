import { NextResponse } from "next/server";
import { z } from "zod";
import { ConversationMemoryError } from "@/lib/ai/conversation-memory";

export const conversationIdSchema = z.string().uuid();
export const languageSchema = z.enum(["es", "en", "zh"]);
export const sourceTypeSchema = z.enum([
  "user",
  "assistant",
  "authorized_database",
  "opportunity_finder",
  "stock_needs",
  "latest_upload"
]);

export function privateJson(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export function conversationMemoryErrorResponse(error: unknown) {
  if (error instanceof ConversationMemoryError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "invalid_content"
          ? 422
          : error.code === "migration_required"
            ? 503
            : 500;
    return privateJson({ error: error.message, code: error.code }, { status });
  }
  return privateJson(
    { error: "Unable to process AI conversation memory.", code: "internal_error" },
    { status: 500 }
  );
}

export async function readJsonBody(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { ok: false as const, response: privateJson({ error: "Content-Type must be application/json." }, { status: 400 }) };
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false as const, response: privateJson({ error: "A valid JSON object is required." }, { status: 400 }) };
  }
  return { ok: true as const, body };
}
