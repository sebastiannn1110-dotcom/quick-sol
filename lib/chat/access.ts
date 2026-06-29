import type { UserRole } from "@/lib/types";

export interface ConversationMemberLike {
  user_id: string;
}

export interface ConversationLike {
  id: string;
  members?: ConversationMemberLike[];
  chat_conversation_members?: ConversationMemberLike[];
}

function membersOf(conversation: ConversationLike) {
  return conversation.members ?? conversation.chat_conversation_members ?? [];
}

export function isConversationMember(conversation: ConversationLike, userId: string) {
  return membersOf(conversation).some((member) => member.user_id === userId);
}

export function filterVisibleConversations<T extends ConversationLike>(conversations: T[], userId: string) {
  return conversations.filter((conversation) => isConversationMember(conversation, userId));
}

export function messageSide(senderId: string | null | undefined, currentUserId: string) {
  return senderId === currentUserId ? "outgoing" : "incoming";
}

export function canOpenChatAudit(role: UserRole) {
  return role === "admin";
}
