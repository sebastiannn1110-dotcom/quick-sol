import type { UserRole } from "@/lib/types";

export const ADMIN_ROLE = "admin" as const;
export const SUPER_ADMIN_DEV_ROLE = "super_admin_dev" as const;

export type AdminRole = typeof ADMIN_ROLE | typeof SUPER_ADMIN_DEV_ROLE;
export type RoleCapability =
  | "AUTHENTICATED"
  | "ADMIN"
  | "SUPERADMIN"
  | "MANAGE_CLIENTS"
  | "OF_TENANT_ADMIN";

export type RoleCapabilities = {
  canAccessAdmin: boolean;
  canAccessAdminDev: boolean;
};

export function roleHasCapability(
  role: UserRole | null | undefined,
  capability: RoleCapability
) {
  if (!role) return false;
  switch (capability) {
    case "AUTHENTICATED":
      return ["employee", "manager", ADMIN_ROLE, SUPER_ADMIN_DEV_ROLE].includes(role);
    case "ADMIN":
    case "OF_TENANT_ADMIN":
      return role === ADMIN_ROLE || role === SUPER_ADMIN_DEV_ROLE;
    case "SUPERADMIN":
      return role === SUPER_ADMIN_DEV_ROLE;
    case "MANAGE_CLIENTS":
      return role === "manager" || role === ADMIN_ROLE || role === SUPER_ADMIN_DEV_ROLE;
  }
}

export function isAdmin(role: UserRole | null | undefined): role is AdminRole {
  return roleHasCapability(role, "ADMIN");
}

export function canAccessAdmin(role: UserRole | null | undefined) {
  return isAdmin(role);
}

export function isSuperAdminDev(role: UserRole | null | undefined): role is typeof SUPER_ADMIN_DEV_ROLE {
  return roleHasCapability(role, "SUPERADMIN");
}

export function canAccessAdminDev(role: UserRole | null | undefined) {
  return isSuperAdminDev(role);
}

export function getRoleCapabilities(role: UserRole | null | undefined): RoleCapabilities {
  return {
    canAccessAdmin: canAccessAdmin(role),
    canAccessAdminDev: canAccessAdminDev(role)
  };
}

export function roleSatisfiesAny(role: UserRole, allowedRoles: readonly UserRole[]) {
  if (allowedRoles.includes(role)) return true;
  return isSuperAdminDev(role) && allowedRoles.includes(ADMIN_ROLE);
}
