import { describe, expect, it } from "vitest";
import { canCreateChatGroup, canCreateDirectChat, canManageCompanyConversation } from "@/lib/chat/chat-permissions";
import { chatMessageSchema, conversationSchema } from "@/lib/chat/chat-service";

describe("chat permissions and validation", () => {
  it("allows all active roles to start a direct chat", () => {
    expect(canCreateDirectChat("employee")).toBe(true);
    expect(canCreateDirectChat("manager")).toBe(true);
  });

  it("reserves groups and company management for admins", () => {
    expect(canCreateChatGroup("admin")).toBe(true);
    expect(canCreateChatGroup("manager")).toBe(false);
    expect(canManageCompanyConversation("employee")).toBe(false);
  });

  it("rejects empty text messages and malformed groups", () => {
    expect(chatMessageSchema.safeParse({ body: "", messageType: "text" }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ body: "Hola", messageType: "text" }).success).toBe(true);
    expect(conversationSchema.safeParse({ type: "direct", participantIds: [] }).success).toBe(false);
  });
});
