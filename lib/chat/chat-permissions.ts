import type { UserRole } from "@/lib/types";

export function canCreateChatGroup(role: UserRole) {
  return role === "admin";
}

export function canCreateDirectChat(role: UserRole) {
  return role === "admin" || role === "manager" || role === "employee";
}

export function canManageCompanyConversation(role: UserRole) {
  return role === "admin";
}
