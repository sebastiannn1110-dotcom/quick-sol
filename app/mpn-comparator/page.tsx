"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import MpnComparator from "@/components/mpn/MpnComparator";

function MpnComparatorContent() {
  const searchParams = useSearchParams();
  const mpn = searchParams.get("mpn") ?? "";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-orange-700">MPN Price Comparator</p>
        <h1 className="text-2xl font-semibold text-slate-950">Comparador de Precios por MPN</h1>
        <p className="mt-2 text-sm text-slate-500">
          Compara proveedores, precios, disponibilidad, lead time, margen y fuente del dato para un MPN.
        </p>
      </div>
      <MpnComparator initialMpn={mpn} />
    </div>
  );
}

export default function MpnComparatorPage() {
  return (
    <Suspense fallback={<div className="rounded-md bg-white p-6 text-sm text-slate-500 shadow-sm">Loading MPN comparator...</div>}>
      <MpnComparatorContent />
    </Suspense>
  );
}
