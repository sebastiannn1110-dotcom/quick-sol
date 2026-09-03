export const ELECTRONIC_PARTS_DEMO_SEED_MARKER = "QUIKSOL_DEMO_DATA_V1";
export const ELECTRONIC_PARTS_DEMO_OWNER_EMAIL = "user.test.demo.com@demo.invalid";

export const ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS = Object.freeze([
  "olivia.mercer@quiksol.demo.invalid",
  "daniel.brooks@quiksol.demo.invalid",
  "maya.torres@quiksol.demo.invalid",
  "jordan.lee@quiksol.demo.invalid",
  "sofia.ramirez@quiksol.demo.invalid",
  "lucas.almeida@quiksol.demo.invalid",
  "emma.clarke@quiksol.demo.invalid",
  "priya.nair@quiksol.demo.invalid",
  "ethan.tan@quiksol.demo.invalid",
  "li.na@quiksol.demo.invalid",
  "haruto.sato@quiksol.demo.invalid",
  "minjun.park@quiksol.demo.invalid",
  "chloe.wilson@quiksol.demo.invalid",
  "lukas.weber@quiksol.demo.invalid",
  "hannah.fischer@quiksol.demo.invalid",
  "camille.laurent@quiksol.demo.invalid",
  "oliver.bennett@quiksol.demo.invalid",
  "lucia.garcia@quiksol.demo.invalid",
  "lin.wei@quiksol.demo.invalid"
] as const);

export const ELECTRONIC_PARTS_DEMO_RETIRED_EMPLOYEE_EMAILS = Object.freeze([
  "aya.nakamura@quiksol.demo.invalid",
  "chen.rui@quiksol.demo.invalid",
  "wei.ming@quiksol.demo.invalid",
  "zhao.lian@quiksol.demo.invalid",
  "mei.chen@quiksol.demo.invalid",
  "yuki.tanaka@quiksol.demo.invalid",
  "noah.williams@quiksol.demo.invalid",
  "isabella.rossi@quiksol.demo.invalid"
] as const);

type ProfileIdentity = Readonly<{ email?: unknown }>;

const visibleEmployeeEmails = new Set<string>(ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS);

function normalizedEmail(profile: ProfileIdentity) {
  return typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
}

export function isElectronicPartsDemoEmployee(profile: ProfileIdentity) {
  return visibleEmployeeEmails.has(normalizedEmail(profile));
}

export function scopeElectronicPartsDemoEmployees<T extends ProfileIdentity>(profiles: readonly T[]) {
  return profiles.filter(isElectronicPartsDemoEmployee);
}
