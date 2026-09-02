import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { loadEmployeeCompensation } from "@/lib/organization/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ employeeId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const { employeeId: rawEmployeeId } = await params;
  const employeeId = z.string().uuid().safeParse(rawEmployeeId);
  if (!employeeId.success) {
    return NextResponse.json(
      { error: "Invalid employee.", code: "INVALID_EMPLOYEE" },
      { status: 400 }
    );
  }

  try {
    const compensation = await loadEmployeeCompensation(context, employeeId.data);
    if (!compensation) {
      return NextResponse.json(
        { error: "Compensation record not found.", code: "COMPENSATION_NOT_FOUND" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { compensation },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CompensationForbiddenError") {
      return NextResponse.json(
        { error: "Compensation access is restricted.", code: "COMPENSATION_FORBIDDEN" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "Unable to load compensation.", code: "COMPENSATION_UNAVAILABLE" },
      { status: 500 }
    );
  }
}
