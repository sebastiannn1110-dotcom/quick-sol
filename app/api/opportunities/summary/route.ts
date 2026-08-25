import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import {
  isSummaryUnavailableError,
  requireBusinessSummaryReady,
  requireReadySummary,
  summaryResponseHeaders,
  summaryUnavailableHttpStatus,
  summaryUnavailablePayload
} from "@/lib/performance/summary-readiness";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SummaryRpcRow = {
  ready?: boolean;
  data_version?: number | string;
  total_opportunities?: number | string;
  immediate_sale?: number | string;
  partial_sale?: number | string;
  excess_resale?: number | string;
  sourcing_needed?: number | string;
  stock_without_demand?: number | string;
  approved_part_matches?: number | string;
  received_history_matches?: number | string;
};

function numeric(value: number | string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rpcPayload(row: SummaryRpcRow) {
  return {
    totals: {
      totalOpportunities: numeric(row.total_opportunities),
      immediateSale: numeric(row.immediate_sale),
      partialSale: numeric(row.partial_sale),
      excessResale: numeric(row.excess_resale),
      sourcingNeeded: numeric(row.sourcing_needed),
      stockWithoutDemand: numeric(row.stock_without_demand),
      approvedPartMatches: numeric(row.approved_part_matches),
      receivedHistoryMatches: numeric(row.received_history_matches)
    },
    dataVersion: numeric(row.data_version),
    source: "versioned_summary"
  };
}

export async function GET(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;
  if (context.isDemoMode || !context.supabase) {
    return NextResponse.json(rpcPayload({ ready: true }));
  }

  try {
    await requireBusinessSummaryReady(context.supabase);
    const { data, error } = await context.supabase.rpc("get_opportunity_summary_v1");
    const row = requireReadySummary<SummaryRpcRow>(data, error);
    return NextResponse.json(redactSensitiveFieldsForRole(rpcPayload(row), context.profile.role), {
      headers: summaryResponseHeaders()
    });
  } catch (summaryError) {
    if (isSummaryUnavailableError(summaryError)) {
      return NextResponse.json(summaryUnavailablePayload(summaryError.state), {
        status: summaryUnavailableHttpStatus(summaryError.state),
        headers: summaryResponseHeaders(summaryError.state)
      });
    }
    return NextResponse.json({ error: "Unable to load opportunity summary." }, { status: 500 });
  }
}
