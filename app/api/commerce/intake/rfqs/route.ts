import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function disabled() {
  return NextResponse.json(
    { error: "integration_disabled" },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}

export const GET = disabled;
export const POST = disabled;
