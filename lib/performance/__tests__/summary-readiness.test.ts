import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  aggregateSummaryStates,
  loadBusinessSummaryState,
  parseSummaryUnavailablePayload,
  readBusinessSummaryWithFence,
  requireReadySummary,
  SummaryDataReadError,
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

  it("preserves only the sanitized database code on a real RPC failure", () => {
    expect(() => requireReadySummary(null, {
      code: "57014",
      message: "canceling statement due to statement timeout"
    })).toThrowError(SummaryDataReadError);

    try {
      requireReadySummary(null, { code: "57014", message: "database internals" });
    } catch (error) {
      expect(error).toMatchObject({
        message: "SUMMARY_DATA_READ_FAILED",
        kind: "rpc",
        stage: "data_rpc",
        dbCode: "57014",
        category: "STATEMENT_TIMEOUT",
        errorClass: "PostgrestError",
        retryable: true
      });
      expect(error).not.toHaveProperty("details");
      expect(error).not.toHaveProperty("hint");
    }
  });

  it("classifies an invalid RPC payload as DATA_SHAPE_INVALID", () => {
    expect(() => requireReadySummary({ items: [], totals: {}, meta: {} })).toThrowError(
      "SUMMARY_DATA_SHAPE_INVALID"
    );
    expect(() => requireReadySummary([])).toThrowError("SUMMARY_DATA_SHAPE_INVALID");
  });

  it.each([
    ["57014", "STATEMENT_TIMEOUT", true],
    ["40001", "SERIALIZATION_FAILURE", true],
    ["40P01", "DEADLOCK", true],
    ["08006", "CONNECTION_FAILURE", true],
    ["42501", "PERMISSION_FAILURE", false],
    ["PGRST500", "POSTGREST_FAILURE", false],
    ["XX000", "UNKNOWN_DB_FAILURE", false]
  ] as const)("classifies injected database code %s as %s", (code, category, retryable) => {
    try {
      requireReadySummary(null, { code, message: "must not be retained" });
      throw new Error("EXPECTED_SUMMARY_DATA_ERROR");
    } catch (error) {
      expect(error).toMatchObject({ dbCode: code, category, retryable });
      expect(error).not.toHaveProperty("code");
      expect(JSON.stringify(error)).not.toContain("must not be retained");
    }
  });

  it("classifies an interrupted transport separately and preserves both READY fences", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 4, requiredVersion: 4 }, error: null })
      .mockResolvedValueOnce({ data: { summaryReady: true, status: "ready", currentVersion: 4, requiredVersion: 4 }, error: null });
    const supabase = { rpc } as unknown as SupabaseClient;
    const interrupted = Object.assign(new Error("connection payload must not be retained"), { code: "08006" });

    await expect(readBusinessSummaryWithFence(
      supabase,
      {},
      async () => { throw interrupted; }
    )).rejects.toMatchObject({
      message: "SUMMARY_DATA_READ_FAILED",
      kind: "transport",
      stage: "data_transport",
      dbCode: "08006",
      category: "CONNECTION_FAILURE",
      errorClass: "TransportError",
      retryable: true,
      before: { status: "ready" },
      after: { status: "ready" },
      rpcDurationMs: expect.any(Number)
    });
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
