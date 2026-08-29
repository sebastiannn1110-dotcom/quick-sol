import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { loadEmployeeAnalytics } from "@/lib/employee-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  try {
    const analytics = await loadEmployeeAnalytics(context);
    return NextResponse.json(
      { analytics },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to load employee analytics.", code: "EMPLOYEE_ANALYTICS_UNAVAILABLE" },
      { status: 500 }
    );
  }
}
