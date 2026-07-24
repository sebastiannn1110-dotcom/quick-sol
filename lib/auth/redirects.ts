export const AUTHENTICATED_HOME_PATH = "/clients";

export function safePostLoginRedirect(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return AUTHENTICATED_HOME_PATH;

  try {
    const target = new URL(value, "https://quiksol.local");
    if (target.origin !== "https://quiksol.local") return AUTHENTICATED_HOME_PATH;
    if (target.pathname === "/dashboard") target.pathname = AUTHENTICATED_HOME_PATH;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return AUTHENTICATED_HOME_PATH;
  }
}

export function legacyDashboardRedirect(searchParams: URLSearchParams) {
  const target = new URL(AUTHENTICATED_HOME_PATH, "https://quiksol.local");
  for (const key of ["error", "lang", "locale"]) {
    for (const value of searchParams.getAll(key)) target.searchParams.append(key, value);
  }
  return `${target.pathname}${target.search}`;
}
