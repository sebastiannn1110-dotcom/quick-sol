import type { UserRole } from "@/lib/types";
import type {
  BusinessRank,
  OrganizationActor,
  OrganizationMember
} from "./contracts";

type ScopeMember = Pick<OrganizationMember, "profileId" | "managerId">;

export function organizationDescendantIds(
  members: ScopeMember[],
  rootId: string,
  includeRoot = true
) {
  const children = new Map<string, string[]>();
  for (const member of members) {
    if (!member.managerId) continue;
    children.set(member.managerId, [...(children.get(member.managerId) ?? []), member.profileId]);
  }

  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(children.get(current) ?? []));
  }

  if (!includeRoot) visited.delete(rootId);
  return visited;
}

export function canEditOrganizationGlobally(
  role: UserRole,
  businessRank: BusinessRank | null
) {
  return role === "super_admin_dev" || (role === "admin" && businessRank === "owner");
}

export function canReadEmployeeCompensation(
  role: UserRole,
  businessRank: BusinessRank | null
) {
  return role === "super_admin_dev" || (role === "admin" && businessRank === "owner");
}

export function analyticsVisibleEmployeeIds(
  actor: Pick<OrganizationActor, "id" | "technicalRole">,
  members: ScopeMember[]
) {
  if (actor.technicalRole === "admin" || actor.technicalRole === "super_admin_dev") {
    return new Set(members.map((member) => member.profileId));
  }
  if (actor.technicalRole === "manager") {
    return organizationDescendantIds(members, actor.id, true);
  }
  return new Set([actor.id]);
}

export function canEditOrganizationMember(
  actor: Pick<OrganizationActor, "id" | "technicalRole" | "canEditGlobal">,
  targetId: string,
  members: ScopeMember[]
) {
  if (actor.canEditGlobal) return true;
  if (actor.technicalRole !== "manager" || actor.id === targetId) return false;
  return organizationDescendantIds(members, actor.id, false).has(targetId);
}

export function allowedManagerIds(
  actor: Pick<OrganizationActor, "id" | "technicalRole" | "canEditGlobal">,
  targetId: string,
  members: ScopeMember[]
) {
  if (!canEditOrganizationMember(actor, targetId, members)) return new Set<string>();
  const targetSubtree = organizationDescendantIds(members, targetId, true);
  const actorScope = actor.canEditGlobal
    ? new Set(members.map((member) => member.profileId))
    : organizationDescendantIds(members, actor.id, true);
  return new Set([...actorScope].filter((id) => !targetSubtree.has(id)));
}
