"use client";

import RoleGuard from "@/components/RoleGuard";

export default function EmployeeGuard({ children }: { children: React.ReactNode }) {
  return <RoleGuard allowedRoles={["admin", "manager", "employee"]}>{children}</RoleGuard>;
}
