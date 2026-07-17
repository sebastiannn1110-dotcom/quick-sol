"use client";

import RoleGuard from "@/components/RoleGuard";

export default function AdminManagerGuard({ children }: { children: React.ReactNode }) {
  return <RoleGuard allowedRoles={["admin", "manager"]}>{children}</RoleGuard>;
}
