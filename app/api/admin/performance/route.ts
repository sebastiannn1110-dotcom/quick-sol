import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/context";
import { latencyPercentiles } from "@/lib/performance/query-budgets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await requireAdmin(request);
  if (context instanceof NextResponse) return context;

  if (context.isDemoMode) return NextResponse.json({ logs: [] });

  const { data, error } = await context.supabase!
    .from("performance_logs")
    .select("operation,module,duration_ms,status,metadata,created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: "Unable to load performance logs." }, { status: 500 });
  const byOperation = new Map<string, number[]>();
  for (const row of data ?? []) {
    const values = byOperation.get(row.operation) ?? [];
    values.push(Number(row.duration_ms ?? 0));
    byOperation.set(row.operation, values);
  }
  return NextResponse.json({
    logs: data ?? [],
    percentiles: Array.from(byOperation, ([operation, samples]) => ({ operation, samples: samples.length, ...latencyPercentiles(samples) }))
  });
}
