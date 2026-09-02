export default function StatCard({ label, value, loading = false }: { label: string; value: number | string | null; loading?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm transition-shadow hover:shadow-soft">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold tabular-nums tracking-tight text-slate-950">
        {loading ? <span className="inline-block h-7 w-14 animate-pulse rounded-md bg-slate-200" aria-label="Loading" /> : value ?? "—"}
      </p>
    </div>
  );
}
