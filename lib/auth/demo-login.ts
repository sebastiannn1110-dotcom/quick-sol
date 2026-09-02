import type { Profile } from "@/lib/types";

export const DEMO_OWNER_USERNAME = "user.test.demo.com";
export const DEMO_OWNER_INTERNAL_EMAIL = "user.test.demo.com@demo.invalid";

export function resolveLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  return normalized === DEMO_OWNER_USERNAME ? DEMO_OWNER_INTERNAL_EMAIL : normalized;
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
  return email.replace(/@quiksol\.demo\.invalid$/i, "@demo.invalid");
}
