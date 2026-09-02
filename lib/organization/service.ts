import type { AuthContext } from "@/lib/auth/context";
import {
  canEditOrganizationGlobally,
  canEditOrganizationMember,
  canReadEmployeeCompensation
} from "./scope";
import {
  organizationMemberFromRow,
  type BusinessRank,
  type EmployeeCompensation,
  type OrganizationActor,
  type OrganizationDirectory,
  type OrganizationMember
} from "./contracts";

const ORGANIZATION_SELECT =
  "profile_id,manager_id,business_title,business_rank,department,country,location,responsibilities,version,updated_at";
const PROFILE_SELECT =
  "id,full_name,email,role,department,region,avatar_path,is_active";

type OrganizationRow = Record<string, unknown>;
type ProfileRow = Record<string, unknown>;

function demoDirectory(context: AuthContext): OrganizationDirectory {
  const actor: OrganizationActor = {
    id: context.profile.id,
    technicalRole: context.profile.role,
    businessRank: "individual_contributor",
    canEditGlobal: false,
    canReadCompensation: context.profile.role === "super_admin_dev"
  };
  return {
    actor,
    members: [{
      profileId: context.profile.id,
      managerId: null,
      businessTitle: context.profile.job_title || "Demo employee",
      businessRank: "individual_contributor",
      department: context.profile.department,
      country: null,
      location: context.profile.region,
      responsibilities: "",
      version: 1,
      updatedAt: context.profile.updated_at,
      name: context.profile.full_name,
      email: context.profile.email,
      technicalRole: context.profile.role,
      region: context.profile.region,
      avatarPath: context.profile.avatar_path || null,
      canEdit: false
    }]
  };
}

export async function loadOrganizationDirectory(
  context: AuthContext
): Promise<OrganizationDirectory> {
  if (!context.supabase) return demoDirectory(context);

  const [organizationResult, profilesResult] = await Promise.all([
    context.supabase.from("organization_members").select(ORGANIZATION_SELECT),
    context.supabase.from("profiles").select(PROFILE_SELECT).eq("is_active", true)
  ]);
  if (organizationResult.error) throw organizationResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const rows = (organizationResult.data ?? []) as OrganizationRow[];
  const profiles = (profilesResult.data ?? []) as ProfileRow[];
  const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]));
  const actorRow = rows.find((row) => row.profile_id === context.profile.id);
  const actorRank = actorRow?.business_rank as BusinessRank | undefined;
  const actor: OrganizationActor = {
    id: context.profile.id,
    technicalRole: context.profile.role,
    businessRank: actorRank ?? null,
    canEditGlobal: canEditOrganizationGlobally(context.profile.role, actorRank ?? null),
    canReadCompensation: canReadEmployeeCompensation(context.profile.role, actorRank ?? null)
  };
  const scopeRows = rows.map((row) => ({
    profileId: String(row.profile_id),
    managerId: typeof row.manager_id === "string" ? row.manager_id : null
  }));
  const members: OrganizationMember[] = [];

  for (const row of rows) {
    const profile = profileById.get(String(row.profile_id));
    if (!profile) continue;
    members.push(organizationMemberFromRow(
      row,
      profile,
      canEditOrganizationMember(actor, String(row.profile_id), scopeRows)
    ));
  }

  return { actor, members };
}

export async function loadEmployeeCompensation(
  context: AuthContext,
  employeeId: string
): Promise<EmployeeCompensation | null> {
  const directory = await loadOrganizationDirectory(context);
  if (!directory.actor.canReadCompensation) {
    const error = new Error("COMPENSATION_FORBIDDEN");
    error.name = "CompensationForbiddenError";
    throw error;
  }
  if (!context.supabase) return null;

  const { data, error } = await context.supabase
    .from("employee_compensation")
    .select("employee_id,amount,currency,periodicity,updated_at")
    .eq("employee_id", employeeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    employeeId: String(data.employee_id),
    amount: Number(data.amount),
    currency: "USD",
    periodicity: data.periodicity as EmployeeCompensation["periodicity"],
    updatedAt: String(data.updated_at)
  };
}
