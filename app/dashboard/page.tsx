import { redirect } from "next/navigation";
import { legacyDashboardRedirect } from "@/lib/auth/redirects";

export default async function DashboardRedirectPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const safeParams = new URLSearchParams();
  for (const key of ["error", "lang", "locale"]) {
    const value = values[key];
    if (Array.isArray(value)) value.forEach((item) => safeParams.append(key, item));
    else if (value) safeParams.set(key, value);
  }
  redirect(legacyDashboardRedirect(safeParams));
}
