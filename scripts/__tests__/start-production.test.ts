import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "scripts/start-production.mjs"), "utf8");

describe("production process supervision", () => {
  it("keeps the web process critical and auxiliary workers restartable", () => {
    expect(source).toContain('name: "web"');
    expect(source).toMatch(/name: "web"[\s\S]*?critical: true/);
    expect(source).toMatch(/name: "business-summary-worker"[\s\S]*?critical: false/);
    expect(source).toMatch(/name: "observability-outbox-worker"[\s\S]*?critical: false/);
    expect(source).toMatch(/name: "import-worker"[\s\S]*?scripts\/import-worker\.ts[\s\S]*?critical: false/);
    expect(source).toContain("scheduleRestart(service, nextAttempt)");
    expect(source).toContain("maximumRestartDelayMs");
  });

  it("only an exited critical service stops the whole process group", () => {
    expect(source).toMatch(/if \(service\.critical\) \{[\s\S]*?stopAll\("SIGTERM", 1\)/);
    expect(source).not.toMatch(/if \(!service\.critical\) \{[\s\S]*?stopAll/);
  });
});
