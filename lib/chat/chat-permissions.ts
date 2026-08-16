import type { UserRole } from "@/lib/types";
import { isAdmin } from "@/lib/auth/roles";

export function canCreateChatGroup(role: UserRole) {
  return isAdmin(role);
}

export function canCreateDirectChat(role: UserRole) {
  return isAdmin(role) || role === "manager" || role === "employee";
}

export function canManageCompanyConversation(role: UserRole) {
  return isAdmin(role);
}
