import { BUSINESS_RANKS, type BusinessRank, type OrganizationMember } from "./contracts";
import { organizationDescendantIds } from "./scope";

export type TeamStructureFilters = {
  search: string;
  country: string;
  department: string;
  businessRank: BusinessRank | "";
  teamManagerId: string;
};

export type FilteredOrganizationMembers = {
  members: OrganizationMember[];
  matchedIds: Set<string>;
  hasActiveFilters: boolean;
};

export function emptyTeamStructureFilters(): TeamStructureFilters {
  return {
    search: "",
    country: "",
    department: "",
    businessRank: "",
    teamManagerId: ""
  };
}

function normalized(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

function sortedUnique(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
}

export function organizationFilterOptions(members: OrganizationMember[]) {
  const managerIds = new Set(
    members
      .map((member) => member.managerId)
      .filter((managerId): managerId is string => Boolean(managerId))
  );
  const presentRanks = new Set(members.map((member) => member.businessRank));

  return {
    countries: sortedUnique(members.map((member) => member.country)),
    departments: sortedUnique(members.map((member) => member.department)),
    businessRanks: BUSINESS_RANKS.filter((rank) => presentRanks.has(rank)),
    teamManagers: members
      .filter((member) => managerIds.has(member.profileId))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

export function filterOrganizationMembers(
  members: OrganizationMember[],
  filters: TeamStructureFilters
): FilteredOrganizationMembers {
  const search = normalized(filters.search);
  const hasActiveFilters = Boolean(
    search
      || filters.country
      || filters.department
      || filters.businessRank
      || filters.teamManagerId
  );
  const teamIds = filters.teamManagerId
    ? organizationDescendantIds(members, filters.teamManagerId, true)
    : null;
  const matchedIds = new Set<string>();

  for (const member of members) {
    const searchable = normalized([
      member.name,
      member.email,
      member.businessTitle,
      member.country,
      member.department
    ].filter(Boolean).join(" "));
    if (search && !searchable.includes(search)) continue;
    if (filters.country && member.country !== filters.country) continue;
    if (filters.department && member.department !== filters.department) continue;
    if (filters.businessRank && member.businessRank !== filters.businessRank) continue;
    if (teamIds && !teamIds.has(member.profileId)) continue;
    matchedIds.add(member.profileId);
  }

  if (!hasActiveFilters) {
    return { members, matchedIds, hasActiveFilters };
  }

  const memberById = new Map(members.map((member) => [member.profileId, member]));
  const visibleIds = new Set<string>();
  for (const matchedId of matchedIds) {
    let currentId: string | null = matchedId;
    const lineage = new Set<string>();
    while (currentId && !lineage.has(currentId)) {
      lineage.add(currentId);
      visibleIds.add(currentId);
      currentId = memberById.get(currentId)?.managerId ?? null;
    }
  }

  return {
    members: members.filter((member) => visibleIds.has(member.profileId)),
    matchedIds,
    hasActiveFilters
  };
}
