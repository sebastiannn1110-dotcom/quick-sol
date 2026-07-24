"use client";

import { StockNeedsDashboard } from "@/app/admin/stock-needs/page";
import EmployeeGuard from "@/components/EmployeeGuard";

export default function StockNeedsPage() {
  return (
    <EmployeeGuard>
      <StockNeedsDashboard endpoint="/api/stock-needs" adminMode={false} />
    </EmployeeGuard>
  );
}
