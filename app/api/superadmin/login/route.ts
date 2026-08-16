import { superadminJson } from "@/lib/superadmin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  void request;
  return superadminJson(
    { error: "SUPERADMIN_PARALLEL_LOGIN_DISABLED", loginPath: "/login" },
    { status: 410 }
  );
}
