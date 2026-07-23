import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanMpnOfferForOutput,
  loadMpnComparatorOffers,
  loadMpnSuggestions,
  MPN_COMPARATOR_SELECT,
  MPN_SUGGESTION_LIMIT,
  MPN_SUGGESTION_MIN_LENGTH,
  MPN_SUGGESTION_QUERY_LIMIT,
  mpnLookupCandidates,
  normalizedMpnDisplay
} from "@/lib/mpn/lookup";

type QueryCall = {
  table: string;
  select?: string;
  filters: Array<{ method: string; column: string; value: unknown; extra?: unknown }>;
  orders: Array<{ column: string; options: unknown }>;
  limit?: number;
};

function mockSupabase(responses: Array<{ data: unknown[] | null; error: unknown | null }>) {
  const calls: QueryCall[] = [];
  const supabase = {
    from(table: string) {
      const call: QueryCall = { table, filters: [], orders: [] };
      calls.push(call);
      const builder = {
        select(value: string) {
          call.select = value;
          return builder;
        },
        is(column: string, value: unknown) {
          call.filters.push({ method: "is", column, value });
          return builder;
        },
        in(column: string, value: unknown[]) {
          call.filters.push({ method: "in", column, value });
          return builder;
        },
        gte(column: string, value: unknown) {
          call.filters.push({ method: "gte", column, value });
          return builder;
        },
        lt(column: string, value: unknown) {
          call.filters.push({ method: "lt", column, value });
          return builder;
        },
        order(column: string, options: unknown) {
          call.orders.push({ column, options });
          return builder;
        },
        limit(value: number) {
          call.limit = value;
          return Promise.resolve(responses.shift() ?? { data: [], error: null });
        }
      };
      return builder;
    }
  };

  return { supabase, calls };
}

describe("MPN lookup helpers", () => {
  it("builds exact text candidates without converting MPNs to numbers", () => {
    expect(normalizedMpnDisplay("001234")).toBe("001234");
    expect(normalizedMpnDisplay("1,748,917")).toBe("1748917");
    expect(normalizedMpnDisplay("ABC-001")).toBe("ABC-001");
    expect(cleanMpnOfferForOutput({ id: "1", mpn: "1,748,917", mpn_quoted: "1,748,917" })).toMatchObject({
      mpn: "1748917",
      mpn_quoted: "1748917"
    });
    expect(mpnLookupCandidates("1748917")).toEqual(expect.arrayContaining(["1748917", "1,748,917", "1.748.917"]));
  });

  it("uses an exact indexed MPN filter and returns clean display MPNs for 1748917", async () => {
    const { supabase, calls } = mockSupabase([
      {
        data: [{ id: "1", mpn: "1,748,917", created_at: "2026-07-23T00:00:00Z" }],
        error: null
      }
    ]);

    const rows = await loadMpnComparatorOffers(supabase as never, "1748917");

    expect(rows).toHaveLength(1);
    expect(rows[0].mpn).toBe("1748917");
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("business_records");
    expect(calls[0].select).toBe(MPN_COMPARATOR_SELECT);
    expect(calls[0].select).not.toContain("*");
    expect(calls[0].filters).toContainEqual({ method: "is", column: "archived_at", value: null });
    expect(calls[0].filters).toContainEqual(expect.objectContaining({ method: "in", column: "mpn", value: expect.arrayContaining(["1748917"]) }));
    expect(calls[0].limit).toBeLessThanOrEqual(120);
  });

  it("falls back to MPN quoted only when the indexed MPN column returns no rows", async () => {
    const { supabase, calls } = mockSupabase([
      { data: [], error: null },
      { data: [{ id: "2", mpn_quoted: "ABC-001", created_at: "2026-07-23T00:00:00Z" }], error: null }
    ]);

    const rows = await loadMpnComparatorOffers(supabase as never, "ABC-001");

    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].filters).toContainEqual(expect.objectContaining({ method: "in", column: "mpn", value: expect.arrayContaining(["ABC-001"]) }));
    expect(calls[1].filters).toContainEqual(expect.objectContaining({ method: "in", column: "mpn_quoted", value: expect.arrayContaining(["ABC-001"]) }));
    expect(calls[1].limit).toBeLessThanOrEqual(50);
  });

  it("does not execute suggestion queries for empty or too-short input", async () => {
    const { supabase, calls } = mockSupabase([]);

    expect(await loadMpnSuggestions(supabase as never, "")).toEqual([]);
    expect(await loadMpnSuggestions(supabase as never, "12")).toEqual([]);

    expect(MPN_SUGGESTION_MIN_LENGTH).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("uses a bounded prefix range and limits suggestions", async () => {
    const suggestions = Array.from({ length: 30 }, (_, index) => ({ mpn: `1748917-${index}`, mpn_quoted: `1748917-${index}` }));
    const { supabase, calls } = mockSupabase([
      { data: [], error: null },
      { data: suggestions, error: null }
    ]);

    const result = await loadMpnSuggestions(supabase as never, "1748917");

    expect(result).toHaveLength(MPN_SUGGESTION_LIMIT);
    expect(result[0]).toBe("1748917-0");
    expect(calls).toHaveLength(2);
    expect(calls[0].filters).toContainEqual(expect.objectContaining({ method: "in", column: "mpn", value: expect.arrayContaining(["1,748,917"]) }));
    expect(calls[1].filters).toContainEqual({ method: "is", column: "archived_at", value: null });
    expect(calls[1].filters).toContainEqual({ method: "gte", column: "mpn", value: "1748917" });
    expect(calls[1].filters).toContainEqual({ method: "lt", column: "mpn", value: "1748918" });
    expect(calls[1].limit).toBe(MPN_SUGGESTION_QUERY_LIMIT);
  });

  it("finds historical grouped numeric MPNs in suggestions and deduplicates by normalized MPN", async () => {
    const { supabase } = mockSupabase([
      { data: [{ mpn: "1,748,917", mpn_quoted: null }], error: null },
      { data: [{ mpn: "1748917", mpn_quoted: "1,748,917" }, { mpn: "1748917-A", mpn_quoted: null }], error: null }
    ]);

    const result = await loadMpnSuggestions(supabase as never, "1748917");

    expect(result).toEqual(["1748917", "1748917-A"]);
    expect(result.filter((item) => item === "1748917")).toHaveLength(1);
  });

  it("keeps comparator lookups free of unbounded contains scans and select star", () => {
    const source = [
      "app/api/mpn-comparator/route.ts",
      "app/api/mpn-comparator/suggest/route.ts",
      "lib/mpn/lookup.ts"
    ].map((file) => readFileSync(path.join(process.cwd(), file), "utf8")).join("\n");

    expect(source).not.toContain("ilike");
    expect(source).not.toContain(".or(");
    expect(source).not.toContain('select("*');
  });
});
