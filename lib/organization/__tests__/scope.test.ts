import { describe, expect, it } from "vitest";
import type { OrganizationActor, OrganizationMember } from "@/lib/organization/contracts";
import {
  allowedManagerIds,
  analyticsVisibleEmployeeIds,
  canEditOrganizationGlobally,
  canEditOrganizationMember,
  canReadEmployeeCompensation,
  organizationDescendantIds
} from "@/lib/organization/scope";

const members = [
  { profileId: "owner", managerId: null },
  { profileId: "manager", managerId: "owner" },
  { profileId: "seller", managerId: "manager" },
  { profileId: "nested", managerId: "seller" },
  { profileId: "outside", managerId: "owner" }
] as OrganizationMember[];

function actor(overrides: Partial<OrganizationActor>): OrganizationActor {
  return {
    id: "seller",
    technicalRole: "employee",
    businessRank: "individual_contributor",
    canEditGlobal: false,
    canReadCompensation: false,
    ...overrides
  };
}

describe("organization scopes", () => {
  it("walks a subtree without looping and excludes the root on demand", () => {
    expect([...organizationDescendantIds(members, "manager")]).toEqual([
      "manager",
      "seller",
      "nested"
    ]);
    expect([...organizationDescendantIds(members, "manager", false)]).toEqual([
      "seller",
      "nested"
    ]);
  });

  it("enforces self, subtree, and global employee analytics scopes", () => {
    expect([...analyticsVisibleEmployeeIds(actor({}), members)]).toEqual(["seller"]);
    expect([
      ...analyticsVisibleEmployeeIds(
        actor({ id: "manager", technicalRole: "manager", businessRank: "manager" }),
        members
      )
    ]).toEqual(["manager", "seller", "nested"]);
    expect(
      analyticsVisibleEmployeeIds(actor({ id: "owner", technicalRole: "admin" }), members).size
    ).toBe(5);
  });

  it("uses the hierarchy for a manager even across department and region boundaries", () => {
    const crossFunctionalMembers = [
      { profileId: "cross-manager", managerId: null, department: "Sales", region: "Americas" },
      { profileId: "cross-seller", managerId: "cross-manager", department: "Engineering", region: "APAC" },
      { profileId: "same-department-outside", managerId: null, department: "Sales", region: "EMEA" },
      { profileId: "same-region-outside", managerId: null, department: "Finance", region: "Americas" }
    ];
    const visible = analyticsVisibleEmployeeIds(
      actor({ id: "cross-manager", technicalRole: "manager", businessRank: "manager" }),
      crossFunctionalMembers
    );

    expect([...visible]).toEqual(["cross-manager", "cross-seller"]);
    expect(visible.has("same-department-outside")).toBe(false);
    expect(visible.has("same-region-outside")).toBe(false);
  });

  it("lets a manager edit only descendants and never move them outside the subtree", () => {
    const manager = actor({ id: "manager", technicalRole: "manager", businessRank: "manager" });
    expect(canEditOrganizationMember(manager, "seller", members)).toBe(true);
    expect(canEditOrganizationMember(manager, "manager", members)).toBe(false);
    expect(canEditOrganizationMember(manager, "outside", members)).toBe(false);
    expect([...allowedManagerIds(manager, "seller", members)]).toEqual(["manager"]);
  });

  it("keeps global editing and compensation limited to owner+admin or superdev", () => {
    expect(canEditOrganizationGlobally("admin", "owner")).toBe(true);
    expect(canEditOrganizationGlobally("admin", "executive")).toBe(false);
    expect(canEditOrganizationGlobally("super_admin_dev", null)).toBe(true);

    expect(canReadEmployeeCompensation("admin", "owner")).toBe(true);
    expect(canReadEmployeeCompensation("admin", "executive")).toBe(false);
    expect(canReadEmployeeCompensation("manager", "owner")).toBe(false);
    expect(canReadEmployeeCompensation("super_admin_dev", null)).toBe(true);
  });
});
