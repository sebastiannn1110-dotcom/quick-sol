"use client";

import AdminManagerGuard from "@/components/AdminManagerGuard";
import { StockNeedsDashboard } from "@/components/stock-needs/StockNeedsDashboard";

export default function AdminStockNeedsPage() {
  return (
    <AdminManagerGuard>
      <StockNeedsDashboard />
    </AdminManagerGuard>
  );
}
