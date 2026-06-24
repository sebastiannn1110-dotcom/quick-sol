import type { BusinessCategory } from "@/lib/types";
import CategoryBadge from "@/components/CategoryBadge";

interface ColumnMapperProps {
  detectedCategory?: BusinessCategory;
  recordsUploaded?: number;
}

export default function ColumnMapper({ detectedCategory, recordsUploaded }: ColumnMapperProps) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">Column Mapper</h2>
          <p className="mt-1 text-sm text-slate-500">
            Common Excel headers are mapped into normalized business fields during upload.
          </p>
        </div>
        {detectedCategory ? <CategoryBadge category={detectedCategory} /> : null}
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">Part Number</p>
          <p className="mt-1 text-slate-500">Part Number, PN, MPN</p>
        </div>
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">Quantity</p>
          <p className="mt-1 text-slate-500">Qty, Quantity, Stock</p>
        </div>
        <div className="rounded-md bg-slate-50 p-3">
          <p className="font-medium text-slate-700">Status</p>
          <p className="mt-1 text-slate-500">Payment, shipping, inspection or inventory state</p>
        </div>
      </div>
      {recordsUploaded !== undefined ? (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
          {recordsUploaded} records uploaded and normalized.
        </p>
      ) : null}
    </section>
  );
}
