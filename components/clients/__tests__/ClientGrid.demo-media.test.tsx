// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ClientGrid from "@/components/clients/ClientGrid";
import { LanguageProvider } from "@/components/LanguageProvider";
import type { AccountClient } from "@/lib/clients/clients";
import { DEPLOYED_DEMO_COMPANY_LOGOS } from "@/lib/clients/deployed-demo-company-logos";
import { DEMO_DATA_MANIFEST } from "@/scripts/demo-data-manifest";

afterEach(cleanup);

describe("demo client grid media", () => {
  it("renders exactly 19 client cards with the deployed demo company logos", () => {
    const logoByClientId = new Map(
      DEPLOYED_DEMO_COMPANY_LOGOS.map((asset) => [asset.clientId, asset.publicPath])
    );
    const logoUrlFor = (clientId: string) => {
      const publicPath = logoByClientId.get(clientId);
      if (!publicPath) throw new Error(`Missing deployed demo logo for ${clientId}`);
      return `/${publicPath}`;
    };
    const clients: AccountClient[] = DEMO_DATA_MANIFEST.clients.map((target) => ({
      id: target.id,
      name: target.name,
      description: target.description,
      industry: target.industry,
      region: target.region,
      website: null,
      logoUrl: logoUrlFor(target.id),
      authorizedIdentificationImageUrl: null,
      status: "active",
      fileCount: 0,
      summaryStatus: "ready",
      summaryCurrentVersion: 1,
      summaryRequiredVersion: 1,
      mpnCount: 0,
      opportunityCount: 0,
      immediateSaleCount: 0,
      partialSaleCount: 0,
      sourcingNeededCount: 0,
      stockWithoutDemandCount: 0,
      highConfidenceCount: 0,
      highConfidenceTruncated: false,
      createdAt: "2026-08-29T12:00:00.000Z",
      updatedAt: "2026-08-29T12:00:00.000Z",
      canManage: false
    }));

    render(
      <LanguageProvider>
        <ClientGrid clients={clients} loading={false} canManage={false} />
      </LanguageProvider>
    );

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(19);
    for (const target of DEMO_DATA_MANIFEST.clients) {
      const image = screen.getByRole("img", { name: target.name });
      expect(image.getAttribute("src")).toBe(logoUrlFor(target.id));
      fireEvent.load(image);
    }
    expect(screen.getAllByTestId("client-image")).toHaveLength(19);
    expect(screen.getAllByTestId("client-image").every((image) =>
      image.getAttribute("data-client-image-state") === "ready"
    )).toBe(true);
    expect(screen.queryByTestId("client-image-placeholder")).toBeNull();
  });
});
