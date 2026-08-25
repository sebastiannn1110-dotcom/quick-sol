import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { roleHasCapability, type RoleCapability } from "@/lib/auth/roles";
import type { UserRole } from "@/lib/types";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260822120000_harden_profile_roles_and_superadmin_inheritance.sql"
  ),
  "utf8"
);

const matrix: Record<RoleCapability, readonly UserRole[]> = {
  AUTHENTICATED: ["employee", "manager", "admin", "super_admin_dev"],
  ADMIN: ["admin", "super_admin_dev"],
  SUPERADMIN: ["super_admin_dev"],
  MANAGE_CLIENTS: ["manager", "admin", "super_admin_dev"],
  OF_TENANT_ADMIN: ["admin", "super_admin_dev"]
};

describe("TypeScript and SQL role capability parity", () => {
  it.each(Object.entries(matrix) as Array<[RoleCapability, readonly UserRole[]]>) (
    "keeps %s identical in TypeScript and SQL",
    (capability, allowedRoles) => {
      const sqlExpression = capability === "SUPERADMIN"
        ? `when '${capability}' then target_role = 'super_admin_dev'`
        : `when '${capability}' then target_role in (${allowedRoles.map((role) => `'${role}'`).join(", ")})`;

      expect(migration).toContain(sqlExpression);
      for (const role of matrix.AUTHENTICATED) {
        expect(roleHasCapability(role, capability)).toBe(allowedRoles.includes(role));
      }
    }
  );

  it("routes every SQL admin helper through the authoritative capability matrix", () => {
    expect(migration).toContain("profile_role_has_capability(profile.role, 'ADMIN')");
    expect(migration).toContain("profile_role_has_capability(profile.role, 'SUPERADMIN')");
    expect(migration).toContain("profile_role_has_capability(profile.role, 'MANAGE_CLIENTS')");
    expect(migration).toContain("profile_role_has_capability(profile.role, 'OF_TENANT_ADMIN')");
  });
});
