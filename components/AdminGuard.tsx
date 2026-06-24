"use client";

import RoleGuard from "@/components/RoleGuard";

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  return <RoleGuard allowedRoles={["admin"]}>{children}</RoleGuard>;
}
