import { describe, expect, it } from "vitest";
import {
  DEMO_FULL_ACCESS_INTERNAL_EMAIL,
  DEMO_FULL_ACCESS_USERNAME,
  DEMO_OWNER_INTERNAL_EMAIL,
  DEMO_OWNER_USERNAME,
  isDemoOwnerIdentity,
  resolveLoginIdentifier,
  visibleEmailAddress,
  visibleProfileIdentifier
} from "@/lib/auth/demo-login";

describe("demo login identity presentation", () => {
  it("resolves the presentation username server-side to its Auth email", () => {
    expect(resolveLoginIdentifier(`  ${DEMO_OWNER_USERNAME.toUpperCase()}  `)).toBe(DEMO_OWNER_INTERNAL_EMAIL);
    expect(resolveLoginIdentifier(DEMO_OWNER_INTERNAL_EMAIL)).toBe(DEMO_OWNER_INTERNAL_EMAIL);
    expect(isDemoOwnerIdentity(DEMO_OWNER_USERNAME)).toBe(true);
  });

  it("resolves and presents the full-access demo username without exposing its Auth email", () => {
    expect(resolveLoginIdentifier(`  ${DEMO_FULL_ACCESS_USERNAME.toUpperCase()}  `))
      .toBe(DEMO_FULL_ACCESS_INTERNAL_EMAIL);
    expect(resolveLoginIdentifier(DEMO_FULL_ACCESS_INTERNAL_EMAIL)).toBe(DEMO_FULL_ACCESS_INTERNAL_EMAIL);
    expect(visibleEmailAddress(DEMO_FULL_ACCESS_INTERNAL_EMAIL, DEMO_FULL_ACCESS_USERNAME))
      .toBe(DEMO_FULL_ACCESS_USERNAME);
  });

  it("never presents the owner technical email", () => {
    expect(visibleEmailAddress(DEMO_OWNER_INTERNAL_EMAIL, DEMO_OWNER_USERNAME)).toBe(DEMO_OWNER_USERNAME);
    expect(visibleProfileIdentifier({ email: DEMO_OWNER_INTERNAL_EMAIL, full_name: DEMO_OWNER_USERNAME })).toBe(DEMO_OWNER_USERNAME);
  });

  it("masks the retained technical domain for the seeded employee identities", () => {
    expect(visibleEmailAddress("maya.torres@quiksol.demo.invalid", "Maya Torres — DEMO"))
      .toBe("maya.torres@demo.invalid");
  });
});
