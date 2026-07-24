"use client";

import { useParams } from "next/navigation";
import AdminManagerGuard from "@/components/AdminManagerGuard";
import ClientForm from "@/components/clients/ClientForm";

export default function EditClientPage() {
  const { clientId } = useParams<{ clientId: string }>();
  return <AdminManagerGuard><ClientForm clientId={clientId} /></AdminManagerGuard>;
}
