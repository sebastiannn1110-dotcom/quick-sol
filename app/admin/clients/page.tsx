"use client";

import AdminManagerGuard from "@/components/AdminManagerGuard";
import ClientsDirectory from "@/components/clients/ClientsDirectory";

export default function AdminClientsPage() {
  return (
    <AdminManagerGuard>
      <ClientsDirectory adminMode />
    </AdminManagerGuard>
  );
}
