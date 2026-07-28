import { describe, expect, it } from "vitest";
import {
  mpnIdentity,
  manufacturersConflict
} from "@/lib/opportunity-finder/normalization";

describe("opportunity finder MPN normalization", () => {
  it.each([
    ["001234", "001234", "001234"],
    ["1748917", "1748917", "1748917"],
    ["1,748,917", "1748917", "1748917"],
    ["1.748.917", "1748917", "1748917"],
    ["ABC-001", "ABC-001", "ABC-001"],
    [" SN74LVC2G74 ", "SN74LVC2G74", "SN74LVC2G74"],
    ["abc-001", "abc-001", "ABC-001"]
  ])("preserves display and builds a strict comparison key for %s", (input, display, normalized) => {
    expect(mpnIdentity(input)).toMatchObject({
      rawMpn: input.trim(),
      displayMpn: display,
      normalizedMpn: normalized
    });
  });

  it("keeps hyphens in exact keys and creates a separate review key", () => {
    expect(mpnIdentity("ABC-001")).toMatchObject({
      normalizedMpn: "ABC-001",
      reviewKey: "ABC001"
    });
  });

  it("recognizes common manufacturer aliases without hiding real conflicts", () => {
    expect(manufacturersConflict("TI", "Texas Instruments")).toBe(false);
    expect(manufacturersConflict("Texas Instruments", "Samsung")).toBe(true);
  });
});
