import { describe, expect, it } from "vitest";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
  ELECTRONIC_PARTS_DEMO_RETIRED_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_SEED_MARKER,
  isElectronicPartsDemoEmployee,
  scopeElectronicPartsDemoEmployees
} from "../employee-scope";

describe("Electronic Parts Demo employee scope", () => {
  it("returns exactly the retained 19 and excludes owner, retired, and unrelated profiles", () => {
    const rows = [
      ...ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.map((email, index) => ({
        id: `keep-${index}`,
        email,
        bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
        is_active: true
      })),
      { id: "owner", email: ELECTRONIC_PARTS_DEMO_OWNER_EMAIL, bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER, is_active: true },
      ...ELECTRONIC_PARTS_DEMO_RETIRED_EMPLOYEE_EMAILS.map((email, index) => ({
        id: `remove-${index}`,
        email,
        bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
        is_active: true
      })),
      { id: "unrelated", email: "real.user@example.com", bio: null, is_active: true }
    ];

    const scoped = scopeElectronicPartsDemoEmployees(rows);

    expect(scoped).toHaveLength(19);
    expect(scoped.map((row) => row.email)).toEqual(ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS);
    expect(scoped.some((row) => row.id === "owner" || row.id.startsWith("remove-"))).toBe(false);
  });

  it("requires active state, exact seed marker, and the canonical email allowlist", () => {
    const canonical = {
      email: "  MAYA.TORRES@QUIKSOL.DEMO.INVALID ",
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      is_active: true
    };
    expect(isElectronicPartsDemoEmployee(canonical)).toBe(true);
    expect(isElectronicPartsDemoEmployee({ ...canonical, bio: null })).toBe(false);
    expect(isElectronicPartsDemoEmployee({ ...canonical, bio: "another-dataset" })).toBe(false);
    expect(isElectronicPartsDemoEmployee({ ...canonical, is_active: false })).toBe(false);
    expect(isElectronicPartsDemoEmployee({ ...canonical, email: "user.test.demo.com" })).toBe(false);
    expect(isElectronicPartsDemoEmployee({ ...canonical, email: null })).toBe(false);
  });
});
