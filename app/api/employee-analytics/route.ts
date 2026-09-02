import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import {
  parseEmployeeAnalyticsFilters,
  type EmployeeAnalyticsFilters
} from "@/lib/employee-analytics/contracts";
import { loadEmployeeAnalytics } from "@/lib/employee-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  let filters: EmployeeAnalyticsFilters;
  try {
    filters = parseEmployeeAnalyticsFilters(new URL(request.url).searchParams);
  } catch {
    return NextResponse.json(
      { error: "Invalid employee analytics filters.", code: "EMPLOYEE_ANALYTICS_FILTERS_INVALID" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const analytics = await loadEmployeeAnalytics(context, filters);
    return NextResponse.json(
      { analytics },
      { headers: NO_STORE_HEADERS }
    );
  } catch {
    return NextResponse.json(
      { error: "Unable to load employee analytics.", code: "EMPLOYEE_ANALYTICS_UNAVAILABLE" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
