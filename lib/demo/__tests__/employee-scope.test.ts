import { describe, expect, it } from "vitest";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
  ELECTRONIC_PARTS_DEMO_RETIRED_EMPLOYEE_EMAILS,
  isElectronicPartsDemoEmployee,
  scopeElectronicPartsDemoEmployees
} from "../employee-scope";

describe("Electronic Parts Demo employee scope", () => {
  it("returns exactly the retained 19 and excludes owner, retired, and unrelated profiles", () => {
    const rows = [
      ...ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.map((email, index) => ({ id: `keep-${index}`, email })),
      { id: "owner", email: ELECTRONIC_PARTS_DEMO_OWNER_EMAIL },
      ...ELECTRONIC_PARTS_DEMO_RETIRED_EMPLOYEE_EMAILS.map((email, index) => ({ id: `remove-${index}`, email })),
      { id: "unrelated", email: "real.user@example.com" }
    ];

    const scoped = scopeElectronicPartsDemoEmployees(rows);

    expect(scoped).toHaveLength(19);
    expect(scoped.map((row) => row.email)).toEqual(ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS);
    expect(scoped.some((row) => row.id === "owner" || row.id.startsWith("remove-"))).toBe(false);
  });

  it("normalizes case and whitespace without accepting aliases", () => {
    expect(isElectronicPartsDemoEmployee({ email: "  MAYA.TORRES@QUIKSOL.DEMO.INVALID " })).toBe(true);
    expect(isElectronicPartsDemoEmployee({ email: "user.test.demo.com" })).toBe(false);
    expect(isElectronicPartsDemoEmployee({ email: null })).toBe(false);
  });
});
