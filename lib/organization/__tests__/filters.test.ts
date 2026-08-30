import { describe, expect, it } from "vitest";
import type { BusinessRank, OrganizationMember } from "@/lib/organization/contracts";
import {
  emptyTeamStructureFilters,
  filterOrganizationMembers,
  organizationFilterOptions,
  type TeamStructureFilters
} from "@/lib/organization/filters";

function member(
  profileId: string,
  managerId: string | null,
  name: string,
  businessTitle: string,
  businessRank: BusinessRank,
  department: string,
  country: string,
  email = `${profileId}@quiksol.demo.invalid`
): OrganizationMember {
  return {
    profileId,
    managerId,
    businessTitle,
    businessRank,
    department,
    country,
    location: `${country} — DEMO`,
    responsibilities: "QUIKSOL_DEMO_DATA_V1",
    version: 1,
    updatedAt: "2026-08-29T00:00:00.000Z",
    name,
    email,
    technicalRole: businessRank === "owner" ? "admin" : businessRank === "manager" ? "manager" : "employee",
    region: department === "Sales — DEMO" ? "Americas — DEMO" : "Global — DEMO",
    avatarPath: null,
    canEdit: false
  };
}

const MEMBERS: OrganizationMember[] = [
  member("jason", null, "Jason Boss — DEMO", "Chief Executive Officer — DEMO", "owner", "Executive — DEMO", "Singapore"),
  member("olivia", "jason", "Olivia Mercer — DEMO", "Chief Operating Officer — DEMO", "executive", "Executive — DEMO", "United States"),
  member("daniel", "olivia", "Daniel Brooks — DEMO", "Sales Manager Americas — DEMO", "manager", "Sales — DEMO", "United States"),
  member("maya", "daniel", "Maya Torres — DEMO", "Sales Representative — DEMO", "salesperson", "Sales — DEMO", "Colombia", "maya.torres@quiksol.demo.invalid"),
  member("jordan", "daniel", "Jordan Lee — DEMO", "Account Executive — DEMO", "salesperson", "Sales — DEMO", "Canada"),
  member("lin", "olivia", "Lin Wei — DEMO", "Sourcing Manager Asia — DEMO", "sourcing_manager", "Sourcing — DEMO", "Singapore"),
  member("aya", "lin", "Aya Nakamura — DEMO", "Sourcing Specialist — DEMO", "sourcing_specialist", "Sourcing — DEMO", "Japan")
];

function filters(overrides: Partial<TeamStructureFilters>) {
  return { ...emptyTeamStructureFilters(), ...overrides };
}

describe("Team Structure filters", () => {
  it.each([
    ["Maya Torres", ["maya"]],
    ["maya.torres@quiksol.demo.invalid", ["maya"]],
    ["account executive", ["jordan"]],
    ["colombia", ["maya"]],
    ["sourcing — demo", ["lin", "aya"]]
  ])("searches name, email, title, country, and department (%s)", (search, expected) => {
    const result = filterOrganizationMembers(MEMBERS, filters({ search }));
    expect([...result.matchedIds]).toEqual(expected);
  });

  it("normalizes accents and case in employee searches", () => {
    const accented = MEMBERS.map((item) => item.profileId === "maya"
      ? { ...item, location: "Bogotá — DEMO", businessTitle: "Ejecutiva Bogotá — DEMO" }
      : item);
    const result = filterOrganizationMembers(accented, filters({ search: "EJECUTIVA BOGOTA" }));
    expect([...result.matchedIds]).toEqual(["maya"]);
  });

  it("combines every filter and preserves ancestors without sibling branches", () => {
    const result = filterOrganizationMembers(MEMBERS, filters({
      search: "maya.torres",
      country: "Colombia",
      department: "Sales — DEMO",
      businessRank: "salesperson",
      teamManagerId: "daniel"
    }));

    expect([...result.matchedIds]).toEqual(["maya"]);
    expect(result.members.map((item) => item.profileId)).toEqual([
      "jason",
      "olivia",
      "daniel",
      "maya"
    ]);
    expect(result.members.some((item) => item.profileId === "jordan")).toBe(false);
    expect(result.members.some((item) => item.profileId === "lin")).toBe(false);
  });

  it("treats a team as its manager plus the complete descendant subtree", () => {
    const result = filterOrganizationMembers(MEMBERS, filters({ teamManagerId: "daniel" }));
    expect([...result.matchedIds]).toEqual(["daniel", "maya", "jordan"]);
    expect(result.members.map((item) => item.profileId)).toEqual([
      "jason",
      "olivia",
      "daniel",
      "maya",
      "jordan"
    ]);
  });

  it("returns the full visible directory after filters are cleared", () => {
    const result = filterOrganizationMembers(MEMBERS, emptyTeamStructureFilters());
    expect(result.hasActiveFilters).toBe(false);
    expect(result.members).toBe(MEMBERS);
    expect(result.matchedIds.size).toBe(MEMBERS.length);
  });

  it("derives sorted options only from members already visible to the actor", () => {
    const options = organizationFilterOptions(MEMBERS);
    expect(options.countries).toEqual(["Canada", "Colombia", "Japan", "Singapore", "United States"]);
    expect(options.departments).toEqual(["Executive — DEMO", "Sales — DEMO", "Sourcing — DEMO"]);
    expect(options.businessRanks).toEqual([
      "owner",
      "executive",
      "manager",
      "salesperson",
      "sourcing_manager",
      "sourcing_specialist"
    ]);
    expect(options.teamManagers.map((item) => item.profileId)).toEqual(["daniel", "jason", "lin", "olivia"]);
  });

  it("stops ancestor traversal if defensive input contains a cycle", () => {
    const cyclic = [
      member("one", "two", "One", "Manager", "manager", "Sales", "Singapore"),
      member("two", "one", "Two", "Seller", "salesperson", "Sales", "Singapore")
    ];
    const result = filterOrganizationMembers(cyclic, filters({ search: "Two" }));
    expect(result.members.map((item) => item.profileId)).toEqual(["one", "two"]);
  });
});
