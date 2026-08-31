"use client";

import { useParams } from "next/navigation";
import EmployeeGuard from "@/components/EmployeeGuard";
import QuoteEditor from "@/components/commerce/QuoteEditor";

export default function QuoteEditorPage() {
  const { quoteId } = useParams<{ quoteId: string }>();
  return (
    <EmployeeGuard>
      <QuoteEditor quoteId={quoteId} />
    </EmployeeGuard>
  );
}
