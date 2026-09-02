import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEPLOYED_DEMO_COMPANY_LOGOS } from "@/lib/clients/deployed-demo-company-logos";
import { DEMO_DATA_MANIFEST } from "@/scripts/demo-data-manifest";

const EXPECTED_CLIENT_NAMES = [
  "Amazon-demo",
  "Apple-demo",
  "Bosch-demo",
  "Cisco-demo",
  "Dell-demo",
  "Google-demo",
  "HP-demo",
  "IBM-demo",
  "Intel-demo",
  "Meta-demo",
  "Microsoft-demo",
  "Nvidia-demo",
  "Oracle-demo",
  "Panasonic-demo",
  "Qualcomm-demo",
  "Samsung-demo",
  "Siemens-demo",
  "Sony-demo",
  "Tesla-demo"
];

describe("deployed demo company logos", () => {
  it("keeps the exact 19-client mapping captured from the deployed /clients", () => {
    expect(DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => asset.clientName))
      .toEqual(EXPECTED_CLIENT_NAMES);
    expect(new Set(DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => asset.clientId)).size).toBe(19);
    expect(new Set(DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => asset.publicPath)).size).toBe(19);
    expect(new Set(DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => asset.sourceStoragePath)).size).toBe(19);
    expect(DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => [
      asset.clientId,
      asset.clientName,
      asset.previousLocalPath
    ]).sort()).toEqual(DEMO_DATA_MANIFEST.clients.map((client) => [
      client.id,
      client.name,
      client.media.localPath
    ]).sort());
  });

  it("ships byte-identical copies of all 19 deployed Storage objects", () => {
    for (const asset of DEPLOYED_DEMO_COMPANY_LOGOS) {
      const filePath = path.resolve(process.cwd(), "public", asset.publicPath);
      expect(fs.existsSync(filePath), asset.clientName).toBe(true);
      expect(
        createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        asset.clientName
      ).toBe(asset.sha256);
    }
  });
});
