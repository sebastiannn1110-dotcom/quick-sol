import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("content security policy", () => {
  it("allows generated assistant audio playback", () => {
    const configSource = readFileSync(path.resolve(process.cwd(), "next.config.mjs"), "utf8");

    expect(configSource).toContain("media-src");
    expect(configSource).toContain('"data:"');
    expect(configSource).toContain('"blob:"');
  });
});
