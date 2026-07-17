import { describe, expect, it } from "vitest";
import { buildStockNeedsResult, normalizePartNumberForMatch } from "@/lib/stock-needs/stock-needs";

const inventoryUpload = {
  original_file_name: "inventory.xlsx",
  detected_category: "Inventory",
  status: "completed"
};

const planningUpload = {
  original_file_name: "planning.xlsx",
  detected_category: "pricing/logistica",
  status: "completed_with_warnings"
};

describe("stock needs matching", () => {
  it("normalizes part numbers as text and preserves leading zeroes", () => {
    expect(normalizePartNumberForMatch("  00123 ab  ")).toBe("00123AB");
    expect(normalizePartNumberForMatch("000-45")).toBe("000-45");
    expect(normalizePartNumberForMatch("")).toBeNull();
  });

  it("detects stock from MFG, MPN, STOCK QTY and UNIT COST without exposing cost", () => {
    const result = buildStockNeedsResult({
      records: [
        {
          upload_batch_id: "stock-upload",
          raw_data: { MFG: "Supplier A", MPN: "000-ABC", "STOCK QTY": 10, "UNIT COST": 25.5 },
          normalized_data: {},
          upload_batches: inventoryUpload
        }
      ],
      profiles: [{ upload_batch_id: "stock-upload", detected_template: "inventario" }]
    });

    expect(result.items[0]).toMatchObject({
      mpn: "000-ABC",
      manufacturerName: "Supplier A",
      stockQty: 10,
      coverageStatus: "overstock"
    });
    expect(JSON.stringify(result)).not.toContain("25.5");
    expect(JSON.stringify(result)).not.toContain("UNIT COST");
  });

  it("detects needs from planning pricing and logistics columns", () => {
    const result = buildStockNeedsResult({
      records: [
        {
          upload_batch_id: "needs-upload",
          raw_data: {
            mpn: "ABC-1",
            Item: "ABC-1",
            Quantity: 12,
            status: "open",
            RequiredDate: "2026-08-01",
            LeadTime: "4w",
            ManuName: "Maker One",
            BPName: "Customer One",
            PriceBook: 99
          },
          normalized_data: {},
          upload_batches: planningUpload
        }
      ],
      profiles: [{ upload_batch_id: "needs-upload", detected_template: "pricing/logistica" }]
    });

    expect(result.items[0]).toMatchObject({
      mpn: "ABC-1",
      customerName: "Customer One",
      manufacturerName: "Maker One",
      requiredQty: 12,
      requiredDate: "2026-08-01",
      leadTime: "4w",
      coverageStatus: "no_stock"
    });
    expect(JSON.stringify(result)).not.toContain("99");
  });

  it("detects needs from quotation receipt and logistics columns", () => {
    const result = buildStockNeedsResult({
      records: [
        {
          upload_batch_id: "receipt-upload",
          raw_data: {
            "Global Customer Name": "Customer Two",
            "Global Supplier Name": "Supplier Two",
            "Global Manufacturer Name": "Maker Two",
            "Mfg Partno": "MFG-22",
            "RCPT Qty": 7,
            "USD Extended Price": 700,
            Facility: "WH1"
          },
          normalized_data: {},
          upload_batches: { original_file_name: "receipt.xlsx", detected_category: "cotizacion/logistica", status: "completed" }
        }
      ],
      profiles: [{ upload_batch_id: "receipt-upload", detected_template: "cotizacion/logistica" }]
    });

    expect(result.items[0]).toMatchObject({
      mpn: "MFG-22",
      customerName: "Customer Two",
      supplierName: "Supplier Two",
      manufacturerName: "Maker Two",
      requiredQty: 7,
      coverageStatus: "no_stock"
    });
    expect(JSON.stringify(result)).not.toContain("700");
  });

  it("crosses stock and needs by normalized MPN", () => {
    const result = buildStockNeedsResult({
      records: [
        {
          upload_batch_id: "stock-upload",
          raw_data: { MFG: "Supplier A", MPN: " ab c-1 ", "STOCK QTY": 10, "UNIT COST": 1 },
          normalized_data: {},
          upload_batches: inventoryUpload
        },
        {
          upload_batch_id: "needs-upload",
          raw_data: { Item: "ABC-1", Quantity: 14, RequiredDate: "2026-08-02", LeadTime: "2w", BPName: "Customer" },
          normalized_data: {},
          upload_batches: planningUpload
        }
      ],
      profiles: [
        { upload_batch_id: "stock-upload", detected_template: "inventario" },
        { upload_batch_id: "needs-upload", detected_template: "pricing/logistica" }
      ]
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      mpn: "ABC-1",
      requiredQty: 14,
      stockQty: 10,
      shortageQty: 4,
      coverageStatus: "partial_stock"
    });
  });

  it("calculates in stock, partial, no stock and unknown coverage", () => {
    const result = buildStockNeedsResult({
      records: [
        { upload_batch_id: "stock", raw_data: { MPN: "A", "STOCK QTY": 5 }, upload_batches: inventoryUpload },
        { upload_batch_id: "need", raw_data: { Item: "A", Quantity: 5, status: "open" }, upload_batches: planningUpload },
        { upload_batch_id: "stock", raw_data: { MPN: "B", "STOCK QTY": 2 }, upload_batches: inventoryUpload },
        { upload_batch_id: "need", raw_data: { Item: "B", Quantity: 5, status: "open" }, upload_batches: planningUpload },
        { upload_batch_id: "need", raw_data: { Item: "C", Quantity: 5, status: "open" }, upload_batches: planningUpload },
        { upload_batch_id: "need", raw_data: { Item: "D", Quantity: "not-a-number", status: "open" }, upload_batches: planningUpload }
      ],
      profiles: [
        { upload_batch_id: "stock", detected_template: "inventario" },
        { upload_batch_id: "need", detected_template: "pricing/logistica" }
      ]
    });

    const byMpn = new Map(result.items.map((item) => [item.mpn, item.coverageStatus]));
    expect(byMpn.get("A")).toBe("in_stock");
    expect(byMpn.get("B")).toBe("partial_stock");
    expect(byMpn.get("C")).toBe("no_stock");
    expect(byMpn.get("D")).toBe("unknown");
  });

  it("does not expose raw_data or complete raw rows in output", () => {
    const result = buildStockNeedsResult({
      records: [
        {
          upload_batch_id: "needs-upload",
          raw_data: { Item: "SAFE-1", Quantity: 1, status: "open", SecretColumn: "DO_NOT_EXPOSE" },
          normalized_data: { secret: "DO_NOT_EXPOSE" },
          upload_batches: planningUpload
        }
      ],
      profiles: [{ upload_batch_id: "needs-upload", detected_template: "pricing/logistica" }]
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw_data");
    expect(serialized).not.toContain("normalized_data");
    expect(serialized).not.toContain("DO_NOT_EXPOSE");
  });
});
