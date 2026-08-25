import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  AI_HISTORY_MAX_CHARACTERS,
  AI_HISTORY_MAX_MESSAGES,
  ConversationMemoryError,
  buildSafeHistoryWindow,
  listOwnedConversations,
  loadOwnedConversation,
  sanitizeConversationContent,
  softDeleteOwnedConversation
} from "@/lib/ai/conversation-memory";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class FakeQuery {
  private operation: "select" | "update" = "select";
  private updateValue: Row = {};
  private filters: Array<(row: Row) => boolean> = [];
  private sort: { field: string; ascending: boolean } | null = null;
  private maximum: number | null = null;

  constructor(
    private readonly tables: Tables,
    private readonly table: string
  ) {}

  select() {
    return this;
  }

  update(value: Row) {
    this.operation = "update";
    this.updateValue = value;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  is(field: string, value: unknown) {
    this.filters.push((row) => row[field] === value);
    return this;
  }

  gt(field: string, value: unknown) {
    this.filters.push((row) => String(row[field]) > String(value));
    return this;
  }

  order(field: string, options: { ascending: boolean }) {
    this.sort = { field, ascending: options.ascending };
    return this;
  }

  limit(value: number) {
    this.maximum = value;
    return this;
  }

  async maybeSingle() {
    const result = this.execute();
    return { data: result.data[0] ?? null, error: result.error };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    const source = this.tables[this.table] ?? [];
    let rows = source.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.operation === "update") {
      rows.forEach((row) => Object.assign(row, this.updateValue));
    }
    if (this.sort) {
      const { field, ascending } = this.sort;
      rows = [...rows].sort((left, right) => {
        const comparison = String(left[field]).localeCompare(String(right[field]));
        return ascending ? comparison : -comparison;
      });
    }
    if (this.maximum !== null) rows = rows.slice(0, this.maximum);
    return { data: rows.map((row) => ({ ...row })), error: null };
  }
}

function fakeSupabase(tables: Tables) {
  return {
    from: (table: string) => new FakeQuery(tables, table)
  } as unknown as SupabaseClient;
}

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const conversationA = "30000000-0000-4000-8000-000000000003";
const conversationB = "40000000-0000-4000-8000-000000000004";
const future = "2099-01-01T00:00:00.000Z";

function conversation(id: string, userId: string, title: string): Row {
  return {
    id,
    user_id: userId,
    title,
    language: "es",
    created_at: "2026-07-30T10:00:00.000Z",
    updated_at: "2026-07-30T10:00:00.000Z",
    retention_expires_at: future,
    deleted_at: null
  };
}

function message(id: string, conversationId: string, userId: string, createdAt: string): Row {
  return {
    id,
    conversation_id: conversationId,
    user_id: userId,
    role: "user",
    language: "es",
    intent: "stock",
    source_type: "user",
    content: `Synthetic message ${id}`,
    created_at: createdAt,
    deleted_at: null
  };
}

describe("secure AI conversation memory", () => {
  it("isolates conversation lists and message loads for two different users", async () => {
    const tables: Tables = {
      ai_conversations: [
        conversation(conversationA, userA, "Conversation A"),
        conversation(conversationB, userB, "Conversation B")
      ],
      ai_messages: [
        message("50000000-0000-4000-8000-000000000005", conversationA, userA, "2026-07-30T10:01:00.000Z"),
        message("60000000-0000-4000-8000-000000000006", conversationB, userB, "2026-07-30T10:02:00.000Z")
      ]
    };
    const supabase = fakeSupabase(tables);

    await expect(listOwnedConversations(supabase, userA)).resolves.toEqual([
      expect.objectContaining({ id: conversationA, userId: userA })
    ]);
    await expect(listOwnedConversations(supabase, userB)).resolves.toEqual([
      expect.objectContaining({ id: conversationB, userId: userB })
    ]);
    await expect(loadOwnedConversation(supabase, userA, conversationA)).resolves.toEqual(
      expect.objectContaining({
        conversation: expect.objectContaining({ id: conversationA, userId: userA }),
        messages: [expect.objectContaining({ conversationId: conversationA, userId: userA })]
      })
    );
    await expect(loadOwnedConversation(supabase, userA, conversationB)).rejects.toMatchObject<
      Partial<ConversationMemoryError>
    >({ code: "not_found" });
  });

  it("only soft-deletes a conversation for its owner", async () => {
    const tables: Tables = {
      ai_conversations: [
        conversation(conversationA, userA, "Conversation A"),
        conversation(conversationB, userB, "Conversation B")
      ],
      ai_messages: []
    };
    const supabase = fakeSupabase(tables);

    await expect(softDeleteOwnedConversation(supabase, userA, conversationB)).resolves.toBe(false);
    expect(tables.ai_conversations[1].deleted_at).toBeNull();

    await expect(softDeleteOwnedConversation(supabase, userB, conversationB)).resolves.toBe(true);
    expect(tables.ai_conversations[1].deleted_at).toEqual(expect.any(String));
    await expect(listOwnedConversations(supabase, userB)).resolves.toEqual([]);
  });

  it("redacts UUIDs and email addresses without changing text-like MPNs", () => {
    const sanitized = sanitizeConversationContent(
      "MPN 000-AX9-07; user@example.test; id 123e4567-e89b-42d3-a456-426614174000"
    );

    expect(sanitized).toContain("000-AX9-07");
    expect(sanitized).toContain("[redacted-email]");
    expect(sanitized).toContain("[redacted-id]");
    expect(sanitized).not.toContain("user@example.test");
    expect(sanitized).not.toContain("123e4567-e89b-42d3-a456-426614174000");
  });

  it("builds a chronological last-eight-message window under the character cap", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}`.repeat(1_000),
      createdAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`
    }));
    const history = buildSafeHistoryWindow(messages);

    expect(history.length).toBeLessThanOrEqual(AI_HISTORY_MAX_MESSAGES);
    expect(history.reduce((total, item) => total + item.content.length, 0)).toBeLessThanOrEqual(
      AI_HISTORY_MAX_CHARACTERS
    );
    expect(history.at(-1)?.content).toContain("11");
  });
});

describe("AI conversation migration contract", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260730120000_ai_conversation_memory.sql"),
    "utf8"
  );

  it("defines owner-only RLS for conversations and messages without an admin bypass", () => {
    expect(migration).toContain("alter table public.ai_conversations force row level security");
    expect(migration).toContain("alter table public.ai_messages force row level security");
    expect(migration.match(/auth\.uid\(\) = user_id/g)?.length).toBeGreaterThanOrEqual(8);
    expect(migration).not.toMatch(/is_admin|role\s*=\s*'admin'|current_user_role/);
  });

  it("contains retention, soft deletion, cascade cleanup, and no tool payload columns", () => {
    expect(migration).toContain("retention_expires_at");
    expect(migration).toContain("deleted_at");
    expect(migration).toContain("on delete cascade");
    expect(migration).toContain("ai_messages_content_no_uuid");
    expect(migration).toContain("ai_messages_content_no_email");
    expect(migration).not.toMatch(/\braw_data\b\s+(json|jsonb|text)/i);
    expect(migration).not.toMatch(/\bnormalized_data\b\s+(json|jsonb|text)/i);
    expect(migration).not.toMatch(/\braw_value\b\s+(json|jsonb|text)/i);
    expect(migration).not.toMatch(/\btool_payload\b\s+(json|jsonb|text)/i);
  });
});
