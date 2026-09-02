import { z } from "zod";
import type { UserRole } from "@/lib/types";

export const BUSINESS_RANKS = [
  "owner",
  "executive",
  "director",
  "manager",
  "salesperson",
  "sourcing_manager",
  "sourcing_specialist",
  "individual_contributor"
] as const;

export const COMPENSATION_PERIODICITIES = ["hourly", "monthly", "annual"] as const;

export type BusinessRank = (typeof BUSINESS_RANKS)[number];
export type CompensationPeriodicity = (typeof COMPENSATION_PERIODICITIES)[number];

export type OrganizationMember = {
  profileId: string;
  managerId: string | null;
  businessTitle: string;
  businessRank: BusinessRank;
  department: string | null;
  country: string | null;
  location: string | null;
  responsibilities: string;
  version: number;
  updatedAt: string;
  name: string;
  email: string;
  technicalRole: UserRole;
  region: string | null;
  avatarPath: string | null;
  canEdit: boolean;
};

export type OrganizationActor = {
  id: string;
  technicalRole: UserRole;
  businessRank: BusinessRank | null;
  canEditGlobal: boolean;
  canReadCompensation: boolean;
};

export type OrganizationDirectory = {
  actor: OrganizationActor;
  members: OrganizationMember[];
};

export type EmployeeCompensation = {
  employeeId: string;
  amount: number;
  currency: "USD";
  periodicity: CompensationPeriodicity;
  updatedAt: string;
};

const optionalTrimmed = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((value) => value || null);

export const organizationMemberPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  managerId: z.string().uuid().nullable(),
  businessTitle: z.string().trim().max(160),
  businessRank: z.enum(BUSINESS_RANKS),
  department: optionalTrimmed(160),
  country: optionalTrimmed(100),
  location: optionalTrimmed(200),
  responsibilities: z.string().trim().max(4000)
}).strict();

export type OrganizationMemberPatch = z.infer<typeof organizationMemberPatchSchema>;

export function organizationMemberFromRow(
  row: Record<string, unknown>,
  profile: Record<string, unknown>,
  canEdit: boolean
): OrganizationMember {
  return {
    profileId: String(row.profile_id),
    managerId: typeof row.manager_id === "string" ? row.manager_id : null,
    businessTitle: typeof row.business_title === "string" ? row.business_title : "",
    businessRank: BUSINESS_RANKS.includes(row.business_rank as BusinessRank)
      ? (row.business_rank as BusinessRank)
      : "individual_contributor",
    department: typeof row.department === "string" ? row.department : null,
    country: typeof row.country === "string" ? row.country : null,
    location: typeof row.location === "string" ? row.location : null,
    responsibilities: typeof row.responsibilities === "string" ? row.responsibilities : "",
    version: Number(row.version || 1),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
    name: typeof profile.full_name === "string" ? profile.full_name : "Unknown employee",
    email: typeof profile.email === "string" ? profile.email : "",
    technicalRole: profile.role as UserRole,
    region: typeof profile.region === "string" ? profile.region : null,
    avatarPath: typeof profile.avatar_path === "string" ? profile.avatar_path : null,
    canEdit
  };
}
