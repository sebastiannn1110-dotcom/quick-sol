import type { SupabaseClient } from "@supabase/supabase-js";

export const AI_HISTORY_MAX_MESSAGES = 8;
export const AI_HISTORY_MAX_CHARACTERS = 6_000;
export const AI_CONVERSATION_RETENTION_DAYS = 90;
export const AI_CONVERSATION_TITLE_MAX_CHARACTERS = 120;
export const AI_MESSAGE_MAX_CHARACTERS = 8_000;

export type AiConversationLanguage = "es" | "en" | "zh";
export type AiMessageRole = "user" | "assistant";
export type AiMessageSourceType =
  | "user"
  | "assistant"
  | "authorized_database"
  | "opportunity_finder"
  | "stock_needs"
  | "latest_upload";

export interface AiConversation {
  id: string;
  userId: string;
  title: string;
  language: AiConversationLanguage;
  createdAt: string;
  updatedAt: string;
  retentionExpiresAt: string;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: AiMessageRole;
  language: AiConversationLanguage;
  intent: string | null;
  sourceType: AiMessageSourceType;
  content: string;
  createdAt: string;
}

export interface SafeHistoryMessage {
  role: AiMessageRole;
  content: string;
}

export class ConversationMemoryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "database_error"
      | "invalid_content"
      | "migration_required"
  ) {
    super(message);
    this.name = "ConversationMemoryError";
  }
}

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SAFE_INTENT_PATTERN = /^[a-z0-9_.:-]{1,80}$/i;

const CONVERSATION_SELECT =
  "id,user_id,title,language,created_at,updated_at,retention_expires_at";
const MESSAGE_SELECT =
  "id,conversation_id,user_id,role,language,intent,source_type,content,created_at";

function isMissingTableError(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return record.code === "PGRST205" || /ai_(conversations|messages).*schema cache/i.test(String(record.message ?? ""));
}

function databaseFailure(error: unknown, fallback: string): never {
  if (isMissingTableError(error)) {
    throw new ConversationMemoryError(
      "AI conversation memory is unavailable until migration 20260730120000_ai_conversation_memory.sql is applied.",
      "migration_required"
    );
  }
  throw new ConversationMemoryError(fallback, "database_error");
}

function normalizeLanguage(value: unknown): AiConversationLanguage {
  if (value === "en" || value === "zh") return value;
  return "es";
}

function sanitizePlainText(value: string, maxCharacters: number) {
  return value
    .replace(UUID_PATTERN, "[redacted-id]")
    .replace(EMAIL_PATTERN, "[redacted-email]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxCharacters);
}

export function sanitizeConversationTitle(value: string | null | undefined) {
  const sanitized = sanitizePlainText(value ?? "", AI_CONVERSATION_TITLE_MAX_CHARACTERS);
  return sanitized || "New conversation";
}

export function sanitizeConversationContent(value: string) {
  const sanitized = sanitizePlainText(value, AI_MESSAGE_MAX_CHARACTERS);
  if (!sanitized) {
    throw new ConversationMemoryError("Message content is empty after sanitization.", "invalid_content");
  }
  return sanitized;
}

function safeIntent(value: string | null | undefined) {
  const candidate = value?.trim() ?? "";
  return SAFE_INTENT_PATTERN.test(candidate) ? candidate : null;
}

function conversationFromRow(row: Record<string, unknown>): AiConversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    language: normalizeLanguage(row.language),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    retentionExpiresAt: String(row.retention_expires_at)
  };
}

function messageFromRow(row: Record<string, unknown>): AiMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    role: row.role === "assistant" ? "assistant" : "user",
    language: normalizeLanguage(row.language),
    intent: typeof row.intent === "string" ? row.intent : null,
    sourceType: String(row.source_type) as AiMessageSourceType,
    content: sanitizeConversationContent(String(row.content ?? "")),
    createdAt: String(row.created_at)
  };
}

export function buildSafeHistoryWindow(
  messages: Pick<AiMessage, "role" | "content" | "createdAt">[],
  options: { maxMessages?: number; maxCharacters?: number } = {}
): SafeHistoryMessage[] {
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? AI_HISTORY_MAX_MESSAGES, AI_HISTORY_MAX_MESSAGES));
  const maxCharacters = Math.max(1, Math.min(options.maxCharacters ?? AI_HISTORY_MAX_CHARACTERS, AI_HISTORY_MAX_CHARACTERS));
  const newestFirst = [...messages]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, maxMessages);
  const selected: SafeHistoryMessage[] = [];
  let remaining = maxCharacters;

  for (const message of newestFirst) {
    if (remaining <= 0) break;
    const content = sanitizeConversationContent(message.content);
    const accepted = content.slice(Math.max(0, content.length - remaining));
    if (!accepted) continue;
    selected.push({ role: message.role, content: accepted });
    remaining -= accepted.length;
  }

  return selected.reverse();
}

export async function listOwnedConversations(
  supabase: SupabaseClient,
  userId: string,
  limit = 30
): Promise<AiConversation[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const { data, error } = await supabase
    .from("ai_conversations")
    .select(CONVERSATION_SELECT)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .gt("retention_expires_at", new Date().toISOString())
    .order("updated_at", { ascending: false })
    .limit(safeLimit);
  if (error) databaseFailure(error, "Unable to list AI conversations.");
  return ((data ?? []) as Record<string, unknown>[]).map(conversationFromRow);
}

export async function createOwnedConversation(
  supabase: SupabaseClient,
  userId: string,
  input: { title?: string; language?: AiConversationLanguage; retentionDays?: number } = {}
): Promise<AiConversation> {
  const retentionDays = Math.max(
    1,
    Math.min(input.retentionDays ?? AI_CONVERSATION_RETENTION_DAYS, AI_CONVERSATION_RETENTION_DAYS)
  );
  const retentionExpiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("ai_conversations")
    .insert({
      user_id: userId,
      title: sanitizeConversationTitle(input.title),
      language: normalizeLanguage(input.language),
      retention_expires_at: retentionExpiresAt
    })
    .select(CONVERSATION_SELECT)
    .single();
  if (error || !data) databaseFailure(error, "Unable to create AI conversation.");
  return conversationFromRow(data as Record<string, unknown>);
}

export async function loadOwnedConversation(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string
): Promise<{ conversation: AiConversation; messages: AiMessage[]; safeHistory: SafeHistoryMessage[] }> {
  const { data: conversationData, error: conversationError } = await supabase
    .from("ai_conversations")
    .select(CONVERSATION_SELECT)
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .gt("retention_expires_at", new Date().toISOString())
    .maybeSingle();
  if (conversationError) databaseFailure(conversationError, "Unable to load AI conversation.");
  if (!conversationData) throw new ConversationMemoryError("Conversation not found.", "not_found");

  const { data: messageData, error: messageError } = await supabase
    .from("ai_messages")
    .select(MESSAGE_SELECT)
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(AI_HISTORY_MAX_MESSAGES);
  if (messageError) databaseFailure(messageError, "Unable to load AI messages.");

  const messages = ((messageData ?? []) as Record<string, unknown>[])
    .map(messageFromRow)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    conversation: conversationFromRow(conversationData as Record<string, unknown>),
    messages,
    safeHistory: buildSafeHistoryWindow(messages)
  };
}

export async function appendOwnedMessage(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  input: {
    role: AiMessageRole;
    content: string;
    language?: AiConversationLanguage;
    intent?: string | null;
    sourceType?: AiMessageSourceType;
  }
): Promise<AiMessage> {
  const { data: ownedConversation, error: ownerError } = await supabase
    .from("ai_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .gt("retention_expires_at", new Date().toISOString())
    .maybeSingle();
  if (ownerError) databaseFailure(ownerError, "Unable to verify AI conversation ownership.");
  if (!ownedConversation) throw new ConversationMemoryError("Conversation not found.", "not_found");

  const sourceType = input.sourceType ?? (input.role === "user" ? "user" : "assistant");
  const { data, error } = await supabase
    .from("ai_messages")
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      role: input.role,
      language: normalizeLanguage(input.language),
      intent: safeIntent(input.intent),
      source_type: sourceType,
      content: sanitizeConversationContent(input.content)
    })
    .select(MESSAGE_SELECT)
    .single();
  if (error || !data) databaseFailure(error, "Unable to create AI message.");
  return messageFromRow(data as Record<string, unknown>);
}

export async function softDeleteOwnedConversation(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_conversations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) databaseFailure(error, "Unable to delete AI conversation.");
  return Boolean(data);
}

export async function softDeleteOwnedMessage(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("ai_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) databaseFailure(error, "Unable to delete AI message.");
  return Boolean(data);
}
