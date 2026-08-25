import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { clientExistsInScope, listClientSummaries } from "@/lib/clients/data-source";

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

function fixture(rpcResults: Array<{ data: unknown; error: unknown }>) {
  const from = vi.fn((table: string) => {
    if (table === "clients") return queryResult({ data: [clientRow()], error: null });
    if (table === "client_upload_assignments") return queryResult({ data: [], error: null });
    throw new Error(`Unexpected table: ${table}`);
  });
  const rpc = vi.fn();
  for (const result of rpcResults) rpc.mockResolvedValueOnce(result);
  return { supabase: { from, rpc } as unknown as SupabaseClient, from, rpc };
}

describe("client summary readiness", () => {
  it.each(["queued", "rebuilding", "retrying", "stale", "failed"] as const)(
    "keeps base client data and null metrics for %s without a corpus scan",
    async (status) => {
      const test = fixture([{ data: {
        summaryReady: false,
        status,
        currentVersion: 10,
        requiredVersion: 11
      }, error: null }]);

      const [client] = await listClientSummaries(test.supabase, "employee");

      expect(client).toMatchObject({
        id: CLIENT_ID,
        name: "Synthetic Client",
        fileCount: 0,
        summaryStatus: status,
        summaryCurrentVersion: 10,
        summaryRequiredVersion: 11,
        mpnCount: null,
        opportunityCount: null,
        highConfidenceTruncated: null
      });
      expect(test.rpc).toHaveBeenCalledTimes(1);
      expect(test.rpc).toHaveBeenCalledWith("get_business_summary_state_v2", {
        p_upload_batch_id: null,
        p_client_id: null
      });
      expect(test.from.mock.calls.map(([table]) => table)).toEqual(["clients", "client_upload_assignments"]);
    }
  );

  it("returns real zeros only after both state and metrics are ready", async () => {
    const test = fixture([
      { data: { summaryReady: true, status: "ready", currentVersion: 11, requiredVersion: 11 }, error: null },
      { data: [{
        client_id: CLIENT_ID,
        summary_ready: true,
        mpn_count: 0,
        opportunity_count: 0,
        immediate_sale_count: 0,
        partial_sale_count: 0,
        sourcing_needed_count: 0,
        stock_without_demand_count: 0,
        high_confidence_count: 0,
        high_confidence_truncated: false
      }], error: null }
    ]);

    const [client] = await listClientSummaries(test.supabase, "employee");

    expect(client).toMatchObject({
      summaryStatus: "ready",
      mpnCount: 0,
      opportunityCount: 0,
      highConfidenceCount: 0,
      highConfidenceTruncated: false
    });
    expect(test.rpc).toHaveBeenCalledTimes(2);
    expect(test.rpc).toHaveBeenNthCalledWith(2, "get_client_business_metrics_v1", {
      target_client_ids: [CLIENT_ID]
    });
  });

  it("fails closed to nullable metrics when the state RPC contract is absent", async () => {
    const test = fixture([{ data: null, error: { code: "PGRST202" } }]);

    const [client] = await listClientSummaries(test.supabase, "employee");

    expect(client.summaryStatus).toBe("contract_unavailable");
    expect(client.opportunityCount).toBeNull();
    expect(test.rpc).toHaveBeenCalledTimes(1);
  });

  it("checks client access without consulting any summary or metrics RPC", async () => {
    const test = fixture([]);

    await expect(clientExistsInScope(test.supabase, "employee", CLIENT_ID)).resolves.toBe(true);

    expect(test.rpc).not.toHaveBeenCalled();
    expect(test.from).toHaveBeenCalledTimes(1);
    expect(test.from).toHaveBeenCalledWith("clients");
  });
});
