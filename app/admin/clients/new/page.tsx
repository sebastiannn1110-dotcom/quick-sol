"use client";

import AdminManagerGuard from "@/components/AdminManagerGuard";
import ClientForm from "@/components/clients/ClientForm";

export default function NewClientPage() {
  return <AdminManagerGuard><ClientForm /></AdminManagerGuard>;
}
