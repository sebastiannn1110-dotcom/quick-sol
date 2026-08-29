"use client";

import RoleGuard from "@/components/RoleGuard";
import EmployeeAnalyticsDashboard from "@/components/employee-analytics/EmployeeAnalyticsDashboard";

export default function EmployeeAnalyticsPage() {
  return (
    <RoleGuard allowedRoles={["employee", "manager", "admin"]}>
      <EmployeeAnalyticsDashboard />
    </RoleGuard>
  );
}
