"use client";

interface SupplierRecommendationCardProps {
  label: string;
  value: string | number | null;
  detail?: string | null;
  accent?: "orange" | "green" | "blue" | "slate";
}

const accentClasses = {
  orange: "border-orange-200 bg-orange-50 text-orange-900",
  green: "border-emerald-200 bg-emerald-50 text-emerald-900",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
  slate: "border-slate-200 bg-white text-slate-950"
};

export default function SupplierRecommendationCard({ label, value, detail, accent = "slate" }: SupplierRecommendationCardProps) {
  return (
    <div className={`rounded-md border p-4 shadow-sm ${accentClasses[accent]}`}>
      <p className="text-sm font-medium opacity-75">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value ?? "-"}</p>
      {detail ? <p className="mt-2 text-sm opacity-80">{detail}</p> : null}
    </div>
  );
}
