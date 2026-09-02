import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { listClientSummaries, resolveClientLogoUrl } from "@/lib/clients/data-source";

const CLIENT_ID = "7e9093e5-6881-40f3-9aee-7a9b495b301c";
const AMAZON_DEMO_ID = "d0000000-0000-4000-8000-000000000001";

function queryResult(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "order", "limit", "eq", "is", "in", "range"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (
    resolve: (value: { data: unknown; error: unknown }) => unknown,
    reject: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function clientRow() {
  return {
    id: CLIENT_ID,
    name: "Synthetic Client",
    description: null,
    industry: null,
    region: null,
    website: null,
    logo_path: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null
  };
}

function createSupabaseFixture() {
  const createSignedUrl = vi.fn(async (path: string) => ({
    data: { signedUrl: `https://signed.example.test/${encodeURIComponent(path)}` },
    error: null
  }));
  const from = vi.fn((table: string) => {
    if (table === "clients") return queryResult({ data: [clientRow()], error: null });
    if (table === "client_upload_assignments") return queryResult({ data: [], error: null });
    if (table === "client_private_details") {
      return queryResult({
        data: [{ client_id: CLIENT_ID, identification_image_path: `${CLIENT_ID}/identification/synthetic.png` }],
        error: null
      });
    }
    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    supabase: {
      from,
      rpc: vi.fn(async () => ({
        data: [{ client_id: CLIENT_ID, summary_ready: true, mpn_count: 0, opportunity_count: 0 }],
        error: null
      })),
      storage: { from: vi.fn(() => ({ createSignedUrl })) }
    } as unknown as SupabaseClient,
    from,
    createSignedUrl
  };
}

describe("client summary images", () => {
  it("renders a local demo company logo_path as its public asset URL", () => {
    expect(resolveClientLogoUrl(CLIENT_ID, "demo/companies/nova-circuit.webp"))
      .toBe("/demo/companies/nova-circuit.webp");
  });

  it("maps the seeded demo path to the exact logo copied from the deployed demo", () => {
    expect(resolveClientLogoUrl(AMAZON_DEMO_ID, "demo/companies/nova-circuit.webp"))
      .toBe("/demo/company-logos/amazon.png");
    expect(resolveClientLogoUrl(AMAZON_DEMO_ID, "/demo/company-logos/amazon.png"))
      .toBe("/demo/company-logos/amazon.png");
  });

  it("preserves an explicitly uploaded storage logo for a demo client", () => {
    expect(resolveClientLogoUrl(AMAZON_DEMO_ID, `${AMAZON_DEMO_ID}/logo/custom.png`))
      .toBe(`/api/clients/${AMAZON_DEMO_ID}/image?kind=logo`);
  });

  it("does not query or return private identification for employees", async () => {
    const fixture = createSupabaseFixture();
    const [client] = await listClientSummaries(fixture.supabase, "employee");

    expect(client.logoUrl).toBeNull();
    expect(client.authorizedIdentificationImageUrl).toBeNull();
    expect(fixture.from).not.toHaveBeenCalledWith("client_private_details");
    expect(fixture.createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns only an authenticated lazy identification URL for an authorized manager", async () => {
    const fixture = createSupabaseFixture();
    const [client] = await listClientSummaries(fixture.supabase, "manager");

    expect(client.logoUrl).toBeNull();
    expect(client.authorizedIdentificationImageUrl)
      .toBe(`/api/clients/${CLIENT_ID}/image?kind=identification`);
    expect(fixture.from).toHaveBeenCalledWith("client_private_details");
    expect(client).not.toHaveProperty("identification_image_path");
    expect(client).not.toHaveProperty("logo_path");
    expect(fixture.createSignedUrl).not.toHaveBeenCalled();
  });
});
