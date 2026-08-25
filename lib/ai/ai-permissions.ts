import type { AuthContext } from "@/lib/auth/context";
import type { UserRole } from "@/lib/types";
import { isAdmin } from "@/lib/auth/roles";

export interface AiPermissionScope {
  role: UserRole;
  userId: string;
  department: string | null;
  region: string | null;
  mode: "company" | "team" | "own";
}

export function getAiPermissionScope(context: AuthContext): AiPermissionScope {
  const role = context.profile.role;
  return {
    role,
    userId: context.profile.id,
    department: context.profile.department,
    region: context.profile.region,
    mode: isAdmin(role) ? "company" : role === "manager" ? "team" : "own"
  };
}

export function canRequestCompanyWideData(role: UserRole) {
  return isAdmin(role);
}

export function mustForceOwnerScope(role: UserRole) {
  return role === "employee";
}

export function questionRequestsCompanyWideData(question: string) {
  const value = question.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return /toda la empresa|todos los registros|global|company wide|entire company|全公司|所有记录/.test(value);
}
