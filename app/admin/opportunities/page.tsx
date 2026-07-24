"use client";

import AdminManagerGuard from "@/components/AdminManagerGuard";
import OpportunitiesDashboard from "@/components/opportunities/OpportunitiesDashboard";

export default function AdminOpportunitiesPage() {
  return (
    <AdminManagerGuard>
      <OpportunitiesDashboard endpoint="/api/admin/opportunities" />
    </AdminManagerGuard>
  );
}
