"use client";

import EmployeeGuard from "@/components/EmployeeGuard";
import OpportunitiesDashboard from "@/components/opportunities/OpportunitiesDashboard";

export default function OpportunitiesPage() {
  return (
    <EmployeeGuard>
      <OpportunitiesDashboard />
    </EmployeeGuard>
  );
}
