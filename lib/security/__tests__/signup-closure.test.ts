import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type SignupSetting = {
  section: string;
  enabled: boolean;
  line: number;
};

const repositoryRoot = process.cwd();
const configPath = path.join(repositoryRoot, "supabase/config.toml");
const publicApplicationRoots = ["app", "components", "lib"] as const;
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const excludedDirectories = new Set(["__tests__", "node_modules"]);

// Any future exception must name the exact production file and explain the approved public flow.
const documentedPublicSignupExceptions: Readonly<Record<string, string>> = Object.freeze({});

function signupSettings(source: string): SignupSetting[] {
  let section = "";
  const settings: SignupSetting[] = [];

  source.split(/\r?\n/).forEach((line, index) => {
    const activeContent = line.replace(/\s+#.*$/, "").trim();
    const sectionMatch = activeContent.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      return;
    }

    const settingMatch = activeContent.match(/^enable_signup\s*=\s*(true|false)$/);
    if (settingMatch) {
      settings.push({
        section,
        enabled: settingMatch[1] === "true",
        line: index + 1
      });
    }
  });

  return settings;
}

function productionSourceFiles(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...productionSourceFiles(relativePath));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(relativePath);
  }

  return files;
}

describe("R8.1 public signup closure", () => {
  it("keeps every versioned signup switch disabled", () => {
    const settings = signupSettings(readFileSync(configPath, "utf8"));
    const bySection = new Map(settings.map((setting) => [setting.section, setting.enabled]));

    expect(bySection.get("auth")).toBe(false);
    expect(bySection.get("auth.email")).toBe(false);
    expect(settings.filter((setting) => setting.enabled)).toEqual([]);
  });

  it("rejects direct Auth signup calls in public application code without a documented exception", () => {
    const directSignupCall = /\.\s*auth\s*(?:\?\.|\.)\s*signUp\s*\(/g;
    const detectedFiles = new Set<string>();
    const violations: string[] = [];

    for (const relativePath of publicApplicationRoots.flatMap(productionSourceFiles)) {
      const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
      for (const match of source.matchAll(directSignupCall)) {
        detectedFiles.add(relativePath);
        const rationale = documentedPublicSignupExceptions[relativePath]?.trim();
        if (!rationale) {
          const line = source.slice(0, match.index).split(/\r?\n/).length;
          violations.push(`${relativePath}:${line}`);
        }
      }
    }

    const staleExceptions = Object.keys(documentedPublicSignupExceptions).filter(
      (relativePath) => !detectedFiles.has(relativePath)
    );
    expect(violations, "Undocumented public auth.signUp calls").toEqual([]);
    expect(staleExceptions, "Stale public signup exceptions").toEqual([]);
  });
});
