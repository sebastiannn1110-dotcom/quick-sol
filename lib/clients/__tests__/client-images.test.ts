import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { listClientSummaries, resolveClientLogoUrl } from "@/lib/clients/data-source";

const CLIENT_ID = "7e9093e5-6881-40f3-9aee-7a9b495b301c";

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

function clientRow(logoPath: string | null = null) {
  return {
    id: CLIENT_ID,
    name: "Synthetic Client",
    description: null,
    industry: null,
    region: null,
    website: null,
    logo_path: logoPath,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null
  };
}

function createSupabaseFixture(logoPath: string | null = null) {
  const createSignedUrl = vi.fn(async (path: string) => ({
    data: { signedUrl: `https://signed.example.test/${encodeURIComponent(path)}` },
    error: null
  }));
  const from = vi.fn((table: string) => {
    if (table === "clients") return queryResult({ data: [clientRow(logoPath)], error: null });
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

describe("resolveClientLogoUrl", () => {
  const authenticatedLogoUrl = `/api/clients/${CLIENT_ID}/image?kind=logo`;

  it("returns only a strictly validated local demo company image", () => {
    expect(resolveClientLogoUrl(CLIENT_ID, "/demo/companies/nova-circuit.webp"))
      .toBe("/demo/companies/nova-circuit.webp");
    expect(resolveClientLogoUrl(CLIENT_ID, "demo/companies/nova-circuit.webp"))
      .toBe("/demo/companies/nova-circuit.webp");
    expect(resolveClientLogoUrl(CLIENT_ID, null)).toBeNull();
  });

  it.each([
    "client-assets/logo/company.webp",
    "/demo/companies/../private.webp",
    "/demo/companies/nova-circuit.png",
    "/demo/companies/Nova-Circuit.webp",
    "/demo/companies/nova_circuit.webp",
    "/demo/companies/nova-circuit.webp?download=1",
    "https://example.test/demo/companies/nova-circuit.webp"
  ])("keeps non-approved path %s behind the authenticated image API", (logoPath) => {
    expect(resolveClientLogoUrl(CLIENT_ID, logoPath)).toBe(authenticatedLogoUrl);
  });
});

describe("client summary images", () => {
  it("returns a validated local demo company image without exposing arbitrary paths", async () => {
    const fixture = createSupabaseFixture("demo/companies/nova-circuit.webp");
    const [client] = await listClientSummaries(fixture.supabase, "employee");

    expect(client.logoUrl).toBe("/demo/companies/nova-circuit.webp");
  });

  it("keeps an existing Storage logo path behind the authenticated image API", async () => {
    const fixture = createSupabaseFixture(`${CLIENT_ID}/logo/123-company.png`);
    const [client] = await listClientSummaries(fixture.supabase, "employee");

    expect(client.logoUrl).toBe(`/api/clients/${CLIENT_ID}/image?kind=logo`);
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
