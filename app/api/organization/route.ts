import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { loadOrganizationDirectory } from "@/lib/organization/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  try {
    const directory = await loadOrganizationDirectory(context);
    return NextResponse.json(directory, {
      headers: { "Cache-Control": "private, no-store, max-age=0" }
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to load team structure.", code: "ORGANIZATION_UNAVAILABLE" },
      { status: 500 }
    );
  }
}
