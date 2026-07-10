import { NextResponse } from "next/server";
import { attemptSuperadminLogin, createSuperadminSessionValue, setSuperadminCookie, superadminLoginSchema } from "@/lib/superadmin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = superadminLoginSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid login payload." }, { status: 400 });

  const result = await attemptSuperadminLogin(request, parsed.data.username, parsed.data.password);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  const response = NextResponse.json({ ok: true });
  setSuperadminCookie(response, createSuperadminSessionValue());
  return response;
}
