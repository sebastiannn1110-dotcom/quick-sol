"use client";

import { StockNeedsDashboard } from "@/components/stock-needs/StockNeedsDashboard";
import EmployeeGuard from "@/components/EmployeeGuard";

export default function StockNeedsPage() {
  return (
    <EmployeeGuard>
      <StockNeedsDashboard endpoint="/api/stock-needs" adminMode={false} />
    </EmployeeGuard>
  );
}
