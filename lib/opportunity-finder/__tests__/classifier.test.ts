import { describe, expect, it } from "vitest";
import {
  classifyOpportunityWorkbook,
  opportunityHeaderScore
} from "@/lib/opportunity-finder/classifier";

function classify(fileName: string, sheetName: string, headers: string[][]) {
  return classifyOpportunityWorkbook({
    fileName,
    rowCount: 10,
    sheets: [{
      sheetName,
      rowCount: 10,
      headerRows: headers.map((values, index) => ({ rowNumber: index + 1, headers: values }))
    }]
  }).detectedType;
}

describe("deterministic opportunity file classification", () => {
  it("detects the real workbook structures", () => {
    expect(classify("snapshot.xlsx", "Planned PO 391", [[
      "Requi", "Item", "Quantity", "RequiredDate", "StartDate", "BPName", "mpn", "ManuName", "SourceControl"
    ]])).toBe("demand");
    expect(classify("snapshot.xlsx", "Sheet1", [["MPN", "MFG", "STOCK QTY", "UNIT COST"]])).toBe("stock");
    expect(classify("neutral.xlsx", "Sheet1", [["MPN", "Maker", "Excess Qty"]])).toBe("excess");
    expect(classify("catalog.xlsx", "All memories", [["List#", "Item#", "Qty", "Price", "Mfr#", "PDL", "Brand"]])).toBe("supplier_offer");
    expect(classify("cube.xlsx", "Actual Spend -- Cube", [[
      "Global Supplier Name", "Global Customer Name", "Mfg Partno", "RCPT Qty", "USD Extended Price"
    ]])).toBe("received_history");
    expect(classify("report.xlsx", "Sales Report", [[
      "SALES PERSON", "ITEM#", "QTY", "UNIT PRICE($)", "UNIT COST($)", "SALES($)", "G.P.(%)"
    ]])).toBe("sales_history");
    expect(classify("aging.xlsx", "ARAgingSummary", [[
      "Customer", "Open Balance", "CREDIT LIMIT", "Due Date", "Total"
    ]])).toBe("financial");
  });

  it("does not call a generic MPN/quantity file excess without explicit context", () => {
    expect(classify("Excess Stock List.xlsx", "Sheet1", [["MPN", "Maker", "Quantity"]])).toBe("unknown");
    expect(classify("generic.xlsx", "Sheet1", [["MPN", "Maker", "Quantity"]])).toBe("unknown");
  });

  it("uses the shared safe demand aliases during classification", () => {
    expect(classify("requirements.xlsx", "Requirements", [[
      "Manufacturer Part Number",
      "Required Qty",
      "Need Date",
      "Customer Name",
      "Unit of Measure"
    ]])).toBe("demand");
  });

  it("recognizes explicit UOM headers without partial abbreviation matches", () => {
    expect(opportunityHeaderScore(["MPN", "STOCK QTY", "UOM"]).recognizedCount).toBe(3);
    expect(opportunityHeaderScore(["Summary", "Comments"])).toMatchObject({
      recognizedCount: 0,
      isHeader: false
    });
  });

  it("keeps evidence and requires confirmation when multiple adapters match", () => {
    const profile = classifyOpportunityWorkbook({
      fileName: "neutral.xlsx",
      rowCount: 4,
      sheets: [
        {
          sheetName: "One",
          rowCount: 2,
          headerRows: [{
            rowNumber: 1,
            headers: ["Line ID", "ORDDD", "GENERIC", "CLEAN_MFG", "RFQ QTY", "Target_to_Vendor"]
          }]
        },
        {
          sheetName: "Two",
          rowCount: 2,
          headerRows: [{
            rowNumber: 1,
            headers: ["MPN", "MFG", "QTY", "Cost", "Price", "Total Price", "GP rate", "GP"]
          }]
        }
      ]
    });
    expect(profile).toMatchObject({ detectedType: "unknown", adapterAmbiguous: true });
    expect(profile.adapterCandidates).toEqual(expect.arrayContaining(["sanmina_spotbuys", "quote_database"]));
    expect(profile.classificationReasons).toContain("ambiguous_adapter_match");
  });
});
