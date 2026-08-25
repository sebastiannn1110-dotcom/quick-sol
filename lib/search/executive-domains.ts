import type { ParsedExecutiveQuery } from "@/lib/search/executive-query-parser";

export type ExecutiveSearchDomain = "records" | "uploads" | "errors" | "users";

export function executiveSearchDomains(parsed: ParsedExecutiveQuery): ExecutiveSearchDomain[] {
  if (parsed.filters.mpn || parsed.intent === "price_comparison") return ["records"];
  if (parsed.intent === "users") return ["users"];
  if (parsed.intent === "errors") return ["errors"];
  if (parsed.intent === "uploads") return ["uploads"];
  if (parsed.intent === "analytics") return ["records", "uploads"];
  return ["records"];
}
