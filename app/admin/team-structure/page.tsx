"use client";

import RoleGuard from "@/components/RoleGuard";
import TeamStructure from "@/components/organization/TeamStructure";

export default function TeamStructurePage() {
  return (
    <RoleGuard allowedRoles={["manager", "admin"]}>
      <TeamStructure />
    </RoleGuard>
  );
}
