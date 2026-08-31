"use client";

import { useParams } from "next/navigation";
import EmployeeGuard from "@/components/EmployeeGuard";
import RfqDetail from "@/components/commerce/RfqDetail";

export default function RfqDetailPage() {
  const { rfqId } = useParams<{ rfqId: string }>();
  return (
    <EmployeeGuard>
      <RfqDetail rfqId={rfqId} />
    </EmployeeGuard>
  );
}
