import type { Profile } from "@/lib/types";

export const DEMO_OWNER_USERNAME = "user.test.demo.com";
export const DEMO_OWNER_INTERNAL_EMAIL = "user.test.demo.com@demo.invalid";
export const DEMO_FULL_ACCESS_USERNAME = "user1.test.demo.com";
export const DEMO_FULL_ACCESS_INTERNAL_EMAIL = "user1.test.demo.com@demo.invalid";

const DEMO_LOGIN_ALIASES = new Map<string, string>([
  [DEMO_OWNER_USERNAME, DEMO_OWNER_INTERNAL_EMAIL],
  [DEMO_FULL_ACCESS_USERNAME, DEMO_FULL_ACCESS_INTERNAL_EMAIL]
]);

export function resolveLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  return DEMO_LOGIN_ALIASES.get(normalized) ?? normalized;
}

export function isDemoOwnerIdentity(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === DEMO_OWNER_USERNAME || normalized === DEMO_OWNER_INTERNAL_EMAIL;
}

export function visibleProfileIdentifier(profile: Pick<Profile, "email" | "full_name"> | null | undefined) {
  if (!profile) return "";
  return visibleEmailAddress(profile.email, profile.full_name);
}

export function visibleEmailAddress(email: string | null | undefined, fullName?: string | null) {
  if (!email) return "";
  if (isDemoOwnerIdentity(email) || isDemoOwnerIdentity(fullName)) return DEMO_OWNER_USERNAME;
  if (
    email.trim().toLowerCase() === DEMO_FULL_ACCESS_INTERNAL_EMAIL ||
    fullName?.trim().toLowerCase() === DEMO_FULL_ACCESS_USERNAME
  ) return DEMO_FULL_ACCESS_USERNAME;
  return email.replace(/@quiksol\.demo\.invalid$/i, "@demo.invalid");
}
