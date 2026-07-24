"use client";

import ClientsDirectory from "@/components/clients/ClientsDirectory";
import EmployeeGuard from "@/components/EmployeeGuard";

export default function ClientsPage() {
  return (
    <EmployeeGuard>
      <ClientsDirectory />
    </EmployeeGuard>
  );
}
