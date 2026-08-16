import { describe, expect, it } from "vitest";
import {
  canAccessAdmin,
  canAccessAdminDev,
  getRoleCapabilities,
  isAdmin,
  isSuperAdminDev,
  roleSatisfiesAny
} from "@/lib/auth/roles";
import type { UserRole } from "@/lib/types";

const roles: UserRole[] = ["employee", "manager", "admin", "super_admin_dev"];

describe("central role capabilities", () => {
  it.each([
    ["employee", false, false],
    ["manager", false, false],
    ["admin", true, false],
    ["super_admin_dev", true, true]
  ] satisfies Array<[UserRole, boolean, boolean]>) (
    "%s resolves admin=%s and admindev=%s",
    (role, admin, adminDev) => {
      expect(getRoleCapabilities(role)).toEqual({ canAccessAdmin: admin, canAccessAdminDev: adminDev });
      expect(canAccessAdmin(role)).toBe(admin);
      expect(canAccessAdminDev(role)).toBe(adminDev);
    }
  );

  it("models Super Admin Dev as an admin superset without reverse inheritance", () => {
    expect(isAdmin("super_admin_dev")).toBe(true);
    expect(isSuperAdminDev("super_admin_dev")).toBe(true);
    expect(roleSatisfiesAny("super_admin_dev", ["admin"])).toBe(true);
    expect(roleSatisfiesAny("admin", ["super_admin_dev"])).toBe(false);
  });

  it("does not expand employee or manager permissions", () => {
    for (const role of roles.filter((value) => value === "employee" || value === "manager")) {
      expect(roleSatisfiesAny(role, ["admin"])).toBe(false);
      expect(roleSatisfiesAny(role, ["super_admin_dev"])).toBe(false);
    }
  });

  it("preserves existing manager and employee allowlists", () => {
    expect(roleSatisfiesAny("manager", ["admin", "manager"])).toBe(true);
    expect(roleSatisfiesAny("employee", ["admin", "manager", "employee"])).toBe(true);
    expect(roleSatisfiesAny("super_admin_dev", ["admin", "manager"])).toBe(true);
  });
});
