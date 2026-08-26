import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateSummaryStates,
  loadBusinessSummaryState,
  parseSummaryUnavailablePayload,
  readBusinessSummaryWithFence,
  requireReadySummary,
  SummaryUnavailableError,
  summaryReadState,
  summaryUnavailableHttpStatus,
  summaryUnavailablePayload
} from "@/lib/performance/summary-readiness";

describe("summary readiness contract", () => {
  it("normalizes the authoritative ready payload and preserves versions", () => {
    expect(summaryReadState({
      summaryReady: true,
      status: "ready",
      currentVersion: 12,
      requiredVersion: 12,
      pendingCount: 0
    })).toEqual({
      status: "ready",
      currentVersion: 12,
      requiredVersion: 12,
      retryable: false,
      retryAfterSeconds: 0,
      pendingCount: 0
    });
  });

  it.each(["dirty", "queued", "rebuilding", "retrying", "stale"] as const)(
    "maps %s to an explicit HTTP 409 payload",
    (status) => {
      const state = summaryReadState({
        summaryReady: false,
        status,
        currentVersion: 11,
        requiredVersion: 12,
        retryAfter: null
      });

      expect(state.status).toBe(status);
      expect(summaryUnavailableHttpStatus(state)).toBe(409);
      expect(summaryUnavailablePayload(state)).toMatchObject({
        errorCode: "SUMMARY_NOT_READY",
        summaryStatus: status,
        currentVersion: 11,
        requiredVersion: 12,
        retryable: true
      });
    }
  );

  it("maps failed and unavailable contracts to distinct HTTP 503 payloads", () => {
    const failed = summaryReadState({ summaryReady: false, status: "failed" });
    const unavailable = summaryReadState(null, { code: "PGRST202" });

    expect(summaryUnavailableHttpStatus(failed)).toBe(503);
    expect(summaryUnavailablePayload(failed).errorCode).toBe("SUMMARY_REBUILD_FAILED");
    expect(summaryUnavailableHttpStatus(unavailable)).toBe(503);
    expect(summaryUnavailablePayload(unavailable)).toMatchObject({
      errorCode: "SUMMARY_CONTRACT_UNAVAILABLE",
      summaryStatus: "contract_unavailable",
      retryable: false
    });
  });

  it("uses the embedded readiness flag as a post-read race fence", () => {
    expect(() => requireReadySummary({ summaryReady: false, items: [] })).toThrowError(SummaryUnavailableError);
    expect(requireReadySummary({ summaryReady: true, items: [] })).toEqual({ summaryReady: true, items: [] });
    expect(summaryReadState({ summaryReady: false }).status).toBe("stale");
  });

  it("parses only sanitized lifecycle response bodies on the client", () => {
    expect(parseSummaryUnavailablePayload({
      error: "The summary is not ready yet.",
      errorCode: "SUMMARY_NOT_READY",
      summaryStatus: "retrying",
      currentVersion: 3,
      requiredVersion: 4,
      retryable: true,
      retryAfterSeconds: 5
    })).toMatchObject({ status: "retrying", retryAfterSeconds: 5 });
    expect(parseSummaryUnavailablePayload({ error: "database details" })).toBeNull();
  });

  it("selects the safest aggregate status without losing version bounds", () => {
    expect(aggregateSummaryStates([
      { status: "ready", currentVersion: 7, requiredVersion: 7, retryable: false, retryAfterSeconds: 0 },
      { status: "rebuilding", currentVersion: 6, requiredVersion: 8, retryable: true, retryAfterSeconds: 3 }
    ])).toMatchObject({
      status: "rebuilding",
      currentVersion: 6,
      requiredVersion: 8
    });
  });

  it("calls the state RPC once with bounded nullable scope parameters", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { summaryReady: true, status: "ready", currentVersion: 2, requiredVersion: 2 },
      error: null
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    await expect(loadBusinessSummaryState(supabase, { uploadBatchId: "upload", clientId: "client" }))
      .resolves.toMatchObject({ status: "ready" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("get_business_summary_state_v2", {
      p_upload_batch_id: "upload",
      p_client_id: "client"
    });
  });

  it("uses the second state read to classify a normal post-read race", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 4, requiredVersion: 4 }, error: null })
      .mockResolvedValueOnce({ data: { summaryReady: false, status: "rebuilding", currentVersion: 4, requiredVersion: 5 }, error: null });
    const supabase = { rpc } as unknown as SupabaseClient;

    await expect(readBusinessSummaryWithFence(
      supabase,
      {},
      async () => ({ data: null, error: { code: "57014" } })
    )).rejects.toMatchObject({
      reason: "post_read",
      state: { status: "rebuilding", currentVersion: 4, requiredVersion: 5 }
    });
  });
});
