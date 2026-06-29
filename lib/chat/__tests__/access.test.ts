import { describe, expect, it } from "vitest";
import { canOpenChatAudit, filterVisibleConversations, isConversationMember, messageSide } from "@/lib/chat/access";

const conversationAB = {
  id: "ab",
  members: [{ user_id: "employee-a" }, { user_id: "employee-b" }]
};

const groupSales = {
  id: "sales",
  members: [{ user_id: "employee-a" }, { user_id: "employee-b" }, { user_id: "manager-sales" }]
};

describe("chat access rules", () => {
  it("keeps direct conversations private to their members", () => {
    expect(isConversationMember(conversationAB, "employee-a")).toBe(true);
    expect(isConversationMember(conversationAB, "employee-b")).toBe(true);
    expect(isConversationMember(conversationAB, "employee-c")).toBe(false);
  });

  it("filters a normal chat list to only conversations where the user participates", () => {
    const visibleForC = filterVisibleConversations([conversationAB, groupSales], "employee-c");
    const visibleForA = filterVisibleConversations([conversationAB, groupSales], "employee-a");
    expect(visibleForC).toEqual([]);
    expect(visibleForA.map((conversation) => conversation.id)).toEqual(["ab", "sales"]);
  });

  it("keeps group conversations visible only to group members", () => {
    expect(isConversationMember(groupSales, "manager-sales")).toBe(true);
    expect(isConversationMember(groupSales, "employee-c")).toBe(false);
  });

  it("marks outgoing and incoming messages for WhatsApp-style layout", () => {
    expect(messageSide("employee-a", "employee-a")).toBe("outgoing");
    expect(messageSide("employee-b", "employee-a")).toBe("incoming");
  });

  it("reserves audit access for admins", () => {
    expect(canOpenChatAudit("admin")).toBe(true);
    expect(canOpenChatAudit("manager")).toBe(false);
    expect(canOpenChatAudit("employee")).toBe(false);
  });
});
