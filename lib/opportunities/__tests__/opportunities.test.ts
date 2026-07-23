import { describe, expect, it } from "vitest";
import {
  buildSalesOpportunitiesResult,
  detectApprovedPartSignals,
  detectDemandRecords,
  detectExcessRecords,
  detectReceivedSignals,
  detectStockRecords,
  summarizeSalesOpportunities
} from "@/lib/opportunities/opportunities";

const inventoryUpload = {
  original_file_name: "inventory.xlsx",
  detected_category: "Inventory",
  status: "completed"
};

const demandUpload = {
  original_file_name: "demand.xlsx",
  detected_category: "pricing/logistica",
  status: "completed"
};

const excessUpload = {
  original_file_name: "excess.xlsx",
  detected_category: "excess",
  status: "completed"
};

describe("sales opportunities engine", () => {
  it("detects immediate_sale when stock covers demand", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "stock", raw_data: { MPN: "001234", "STOCK QTY": 10, "UNIT COST": 25.5 }, upload_batches: inventoryUpload },
        { upload_batch_id: "need", raw_data: { Item: "001234", "Required Qty": 4, "Global Customer Name": "Customer A", PriceBook: 99 }, upload_batches: demandUpload }
      ],
      profiles: [
        { upload_batch_id: "stock", detected_template: "inventario" },
        { upload_batch_id: "need", detected_template: "pricing/logistica" }
      ]
    });

    expect(result.items[0]).toMatchObject({
      opportunityType: "immediate_sale",
      mpn: "001234",
      normalizedMpn: "001234",
      requiredQty: 4,
      availableQty: 10,
      shortageQty: 0
    });
    expect(result.totals.immediateSale).toBe(1);
    expect(JSON.stringify(result)).not.toContain("UNIT COST");
    expect(JSON.stringify(result)).not.toContain("25.5");
    expect(JSON.stringify(result)).not.toContain("PriceBook");
    expect(JSON.stringify(result)).not.toContain("99");
  });

  it("detects partial_sale with shortage", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "stock", raw_data: { MPN: "ABC-001", "STOCK QTY": 4 }, upload_batches: inventoryUpload },
        { upload_batch_id: "need", raw_data: { Item: "ABC-001", Quantity: 10, Customer: "Customer B" }, upload_batches: demandUpload }
      ],
      profiles: [
        { upload_batch_id: "stock", detected_template: "inventario" },
        { upload_batch_id: "need", detected_template: "pricing/logistica" }
      ]
    });

    expect(result.items[0]).toMatchObject({
      opportunityType: "partial_sale",
      mpn: "ABC-001",
      requiredQty: 10,
      availableQty: 4,
      shortageQty: 6
    });
    expect(result.totals.partialSale).toBe(1);
  });

  it("detects sourcing_needed when demand has no stock or excess", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "need", raw_data: { Item: "SRC-1", "Demand Qty": 12, Customer: "Customer C" }, upload_batches: demandUpload }
      ],
      profiles: [{ upload_batch_id: "need", detected_template: "pricing/logistica" }]
    });

    expect(result.items[0]).toMatchObject({
      opportunityType: "sourcing_needed",
      mpn: "SRC-1",
      requiredQty: 12,
      availableQty: null
    });
    expect(result.totals.sourcingNeeded).toBe(1);
  });

  it("detects stock_without_demand for available inventory with no customer need", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "stock", raw_data: { MPN: "STOCK-ONLY", "STOCK QTY": 22, MFG: "Maker" }, upload_batches: inventoryUpload }
      ],
      profiles: [{ upload_batch_id: "stock", detected_template: "inventario" }]
    });

    expect(result.items[0]).toMatchObject({
      opportunityType: "stock_without_demand",
      mpn: "STOCK-ONLY",
      availableQty: 22,
      requiredQty: null
    });
    expect(result.totals.stockWithoutDemand).toBe(1);
  });

  it("detects excess_resale only when a clear excess signal matches demand", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "need", raw_data: { Item: "EX-1", "Required Qty": 8, Customer: "Customer D" }, upload_batches: demandUpload },
        { upload_batch_id: "excess", raw_data: { MPN: "EX-1", Excess: "yes", "Excess Qty": 20, Customer: "Source Owner" }, upload_batches: excessUpload }
      ],
      profiles: [
        { upload_batch_id: "need", detected_template: "pricing/logistica" },
        { upload_batch_id: "excess", detected_template: "excess" }
      ]
    });

    expect(result.items[0]).toMatchObject({
      opportunityType: "excess_resale",
      mpn: "EX-1",
      requiredQty: 8,
      excessQty: 20,
      excessOwnerName: "Source Owner"
    });
    expect(result.totals.excessResale).toBe(1);
    expect(detectExcessRecords({ records: resultInputExcessRecords(), profiles: [{ upload_batch_id: "excess", detected_template: "excess" }] })).toHaveLength(1);
  });

  it("detects approved part and received history signals", () => {
    const records = [
      { upload_batch_id: "need", raw_data: { Item: "AVL-1", "Required Qty": 5, Customer: "Customer E", AVL: "yes" }, upload_batches: demandUpload },
      { upload_batch_id: "receipt", raw_data: { MPN: "AVL-1", "RCPT Qty": 3, status: "received" }, upload_batches: { original_file_name: "receipt.xlsx", detected_category: "logistica", status: "completed" } }
    ];
    const profiles = [
      { upload_batch_id: "need", detected_template: "pricing/logistica" },
      { upload_batch_id: "receipt", detected_template: "logistica" }
    ];
    const result = buildSalesOpportunitiesResult({ records, profiles });

    expect(result.items[0]).toMatchObject({
      opportunityType: "sourcing_needed",
      approvedPartSignal: true,
      receivedSignal: true,
      receivedQty: 3
    });
    expect(result.totals.approvedPartMatches).toBe(1);
    expect(result.totals.receivedHistoryMatches).toBe(1);
    expect(detectApprovedPartSignals({ records, profiles })).toHaveLength(1);
    expect(detectReceivedSignals({ records, profiles })).toHaveLength(1);
  });

  it("keeps MPN as text without numeric formatting", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "need", raw_data: { Item: "1,748,917", Quantity: 4, Customer: "Customer F" }, upload_batches: demandUpload },
        { upload_batch_id: "need", raw_data: { Item: "000-45", Quantity: 1, Customer: "Customer F" }, upload_batches: demandUpload }
      ],
      profiles: [{ upload_batch_id: "need", detected_template: "pricing/logistica" }],
      filters: { limit: 10 }
    });

    const mpns = result.items.map((item) => item.mpn);
    expect(mpns).toContain("1748917");
    expect(mpns).toContain("000-45");
    expect(mpns).not.toContain("1,748,917");
  });

  it("exposes detection helpers for demand and stock records", () => {
    const records = [
      { upload_batch_id: "stock", raw_data: { MPN: "A", "STOCK QTY": 1 }, upload_batches: inventoryUpload },
      { upload_batch_id: "need", raw_data: { Item: "A", Quantity: 2, Customer: "Customer" }, upload_batches: demandUpload }
    ];
    const profiles = [
      { upload_batch_id: "stock", detected_template: "inventario" },
      { upload_batch_id: "need", detected_template: "pricing/logistica" }
    ];

    expect(detectStockRecords({ records, profiles })).toHaveLength(1);
    expect(detectDemandRecords({ records, profiles })).toHaveLength(1);
  });

  it("summarizes opportunities without customer, price, cost or GP values", () => {
    const result = buildSalesOpportunitiesResult({
      records: [
        { upload_batch_id: "need", raw_data: { Item: "SAFE-1", "Required Qty": 3, Customer: "Customer G", GP: 10, "GP rate": 0.2 }, upload_batches: demandUpload }
      ],
      profiles: [{ upload_batch_id: "need", detected_template: "pricing/logistica" }]
    });

    const summary = summarizeSalesOpportunities(result);
    expect(summary).toContain("Encontré");
    expect(summary).toContain("oportunidades comerciales");
    expect(summary).not.toContain("Customer G");
    expect(JSON.stringify(result)).not.toContain("GP rate");
    expect(JSON.stringify(result)).not.toContain("0.2");
  });
});

function resultInputExcessRecords() {
  return [
    { upload_batch_id: "excess", raw_data: { MPN: "EX-2", Excess: "yes", "Excess Qty": 20 }, upload_batches: excessUpload }
  ];
}
