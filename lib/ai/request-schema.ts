import { z } from "zod";

export const AI_MESSAGE_MAX_CHARACTERS = 2_000;
export const AI_TEXT_BODY_MAX_BYTES = 16_384;

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(AI_MESSAGE_MAX_CHARACTERS),
  language: z.enum(["es", "en", "zh"]).optional(),
  jobId: z.uuid().nullable().optional(),
  conversationId: z.uuid().nullable().optional()
}).strict();

export type AssistantRequestBody = z.infer<typeof assistantRequestSchema>;

export type AssistantBodyFailure = {
  ok: false;
  status: 400 | 413 | 422;
  code: "INVALID_CONTENT_TYPE" | "MALFORMED_JSON" | "EMPTY_MESSAGE" | "MESSAGE_TOO_LARGE" | "INVALID_PARAMETERS";
};

export type AssistantBodySuccess = {
  ok: true;
  data: AssistantRequestBody;
};

export async function parseAssistantRequest(
  request: Request
): Promise<AssistantBodyFailure | AssistantBodySuccess> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 400, code: "INVALID_CONTENT_TYPE" };
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > AI_TEXT_BODY_MAX_BYTES) {
    return { ok: false, status: 413, code: "MESSAGE_TOO_LARGE" };
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, code: "MALFORMED_JSON" };
  }
  const rawMessage = (body as Record<string, unknown>).message;
  if (typeof rawMessage !== "string" || !rawMessage.trim()) {
    return { ok: false, status: 400, code: "EMPTY_MESSAGE" };
  }
  if (Array.from(rawMessage).length > AI_MESSAGE_MAX_CHARACTERS) {
    return { ok: false, status: 413, code: "MESSAGE_TOO_LARGE" };
  }

  const parsed = assistantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 422, code: "INVALID_PARAMETERS" };
  }
  return { ok: true, data: parsed.data };
}
