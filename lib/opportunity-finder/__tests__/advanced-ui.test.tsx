// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import OpportunityCard from "@/components/opportunity-finder/OpportunityCard";
import type { OpportunityResult } from "@/lib/opportunity-finder/types";

afterEach(cleanup);

function advancedResult(): OpportunityResult {
  const supplyTrace = {
    fileId: "supply-file",
    fileName: "offer.xlsx",
    sheetName: "Offer",
    sourceRow: 42,
    hidden: true,
    headerRow: 8,
    columns: { offerPrice: "H42", availableQty: "F42" }
  };
  return {
    id: "00000000-0000-4000-8000-000000000042",
    jobId: "job",
    opportunityType: "partial_sale",
    exactMpnMatch: true,
    exactMatch: true,
    usableAvailabilityMatch: true,
    exactQuantityMatch: false,
    matchTier: "exact_mpn_mfg",
    confidence: "high",
    reviewStatus: "pending",
    demandEventKey: "SANMINA-100",
    demandMpnOriginal: "ABC-100",
    supplyMpnOriginal: "ABC-100",
    displayMpn: "ABC-100",
    normalizedMpn: "ABC-100",
    manufacturer: "Example MFG",
    customerContext: "Example customer",
    supplierContext: "Example supplier",
    requiredQty: 100,
    availableQty: 60,
    allocatedQty: 60,
    shortageQty: 40,
    coveragePercent: 60,
    requiredDate: "2026-09-01",
    unitOfMeasure: "EA",
    targetPrice: 12,
    offerPrice: 10,
    targetGapPercent: 16.67,
    currency: "USD",
    revenuePotential: 720,
    unitCost: 8,
    grossProfit: 240,
    grossMarginPercent: 33.33,
    moq: 25,
    spq: 5,
    demandFileId: "demand-file",
    demandFileName: "needs.xlsx",
    demandSheetName: "Needs",
    supplyFileId: "supply-file",
    supplyFileName: "offer.xlsx",
    supplySheetName: "Offer",
    demandSourceRows: 1,
    supplySourceRows: 1,
    demandTraces: [{
      fileId: "demand-file",
      fileName: "needs.xlsx",
      sheetName: "Needs",
      sourceRow: 17,
      hidden: false,
      headerRow: 4,
      columns: { requiredQty: "F17" }
    }],
    supplyTraces: [supplyTrace],
    allocations: [{
      lotKey: "LOT-42",
      allocatedQty: 60,
      reservedQty: 60,
      availableBefore: 80,
      remainingQty: 20,
      supply: supplyTrace
    }],
    reasonCode: "partial_coverage",
    actionCode: "source_remaining_quantity",
    warnings: ["hidden_source_row"]
  };
}

describe("Opportunity Finder advanced card", () => {
  it("keeps protected commercial and financial metrics behind capabilities", () => {
    const result = advancedResult();
    const { rerender } = render(
      <LanguageProvider><OpportunityCard result={result} jobId="job" /></LanguageProvider>
    );
    expect(screen.queryByText("Precio objetivo")).toBeNull();
    expect(screen.queryByText("Costo unitario")).toBeNull();
    expect(screen.getByText("MOQ")).toBeTruthy();

    rerender(
      <LanguageProvider>
        <OpportunityCard result={result} jobId="job" canViewPricing />
      </LanguageProvider>
    );
    expect(screen.getByText("Precio objetivo")).toBeTruthy();
    expect(screen.queryByText("Costo unitario")).toBeNull();

    rerender(
      <LanguageProvider>
        <OpportunityCard result={result} jobId="job" canViewPricing canViewFinancials />
      </LanguageProvider>
    );
    expect(screen.getByText("Costo unitario")).toBeTruthy();
    expect(screen.getByText("Utilidad bruta")).toBeTruthy();
    expect(screen.getByText("Margen bruto")).toBeTruthy();
  });

  it("exposes exact row traces and delegates review decisions", () => {
    const onReview = vi.fn();
    render(
      <LanguageProvider>
        <OpportunityCard result={advancedResult()} jobId="job" onReview={onReview} />
      </LanguageProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Ver origen" }));
    expect(screen.getByText(/needs\.xlsx \/ Needs · Fila 17/)).toBeTruthy();
    expect(screen.getAllByText(/offer\.xlsx \/ Offer · Fila 42/).length).toBeGreaterThan(0);
    expect(screen.getByText("LOT-42")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(screen.getByRole("button", { name: "Rechazar" }));
    expect(onReview).toHaveBeenNthCalledWith(1, "approved");
    expect(onReview).toHaveBeenNthCalledWith(2, "rejected");
  });
});
