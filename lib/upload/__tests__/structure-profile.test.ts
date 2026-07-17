import { describe, expect, it } from "vitest";
import {
  buildUploadStructureProfile,
  formatColumnsAnswer,
  formatDetectedFields
} from "@/lib/upload/structure-profile";

const upload = {
  id: "11111111-1111-4111-8111-111111111111",
  file_type: "xlsx",
  total_rows: 100,
  successful_rows: 98,
  warning_count: 0,
  rows_with_warnings: 0,
  technical_error_count: 0
};

describe("upload structure profiles", () => {
  it("generates a structural profile from upload sheet headers", () => {
    const profile = buildUploadStructureProfile({
      upload,
      sheets: [
        {
          upload_batch_id: upload.id,
          sheet_name: "Sheet1",
          total_rows: 100,
          headers_json: ["MFG", "MPN", "STOCK QTY", "UNIT COST"]
        }
      ]
    });

    expect(profile.columnCount).toBe(4);
    expect(profile.detectedTemplate).toBe("inventario");
    expect(profile.detectedMappings).toMatchObject({
      fabricante: "MFG",
      mpn: "MPN",
      cantidad: "STOCK QTY",
      costo: "UNIT COST"
    });
  });

  it("generates a structural profile from business record keys without storing values", () => {
    const profile = buildUploadStructureProfile({
      upload,
      records: [
        {
          raw_data: {
            MFG: "REAL_SUPPLIER_NAME",
            MPN: "REAL-MPN-ABC-123",
            "STOCK QTY": 77,
            "UNIT COST": 12345.67
          },
          normalized_data: {
            mpn: "REAL-MPN-ABC-123",
            supplier: "REAL_SUPPLIER_NAME",
            qty: 77,
            cost: 12345.67
          }
        }
      ]
    });

    const serialized = JSON.stringify(profile);
    expect(profile.columns.map((column) => column.name)).toEqual(expect.arrayContaining(["MFG", "MPN", "STOCK QTY", "UNIT COST"]));
    expect(profile.detectedTemplate).toBe("inventario");
    expect(serialized).not.toContain("REAL_SUPPLIER_NAME");
    expect(serialized).not.toContain("REAL-MPN-ABC-123");
    expect(serialized).not.toContain("12345.67");
  });

  it("detects pricing and logistics templates from expected structural columns", () => {
    const profile = buildUploadStructureProfile({
      upload,
      sheets: [
        {
          upload_batch_id: upload.id,
          total_rows: 10,
          headers_json: ["PriceBook", "Quantity", "LeadTime", "status"]
        }
      ]
    });

    expect(profile.detectedTemplate).toBe("pricing/logistica");
    expect(profile.detectedMappings).toMatchObject({
      precio: "PriceBook",
      cantidad: "Quantity",
      estado: "status"
    });
  });

  it("detects quotation and logistics templates from receipt-style columns", () => {
    const profile = buildUploadStructureProfile({
      upload,
      sheets: [
        {
          upload_batch_id: upload.id,
          total_rows: 10,
          headers_json: ["Global Customer Name", "Global Supplier Name", "RCPT Qty", "USD Extended Price"]
        }
      ]
    });

    expect(profile.detectedTemplate).toBe("cotizacion/logistica");
    expect(profile.detectedMappings).toMatchObject({
      cliente: "Global Customer Name",
      proveedor: "Global Supplier Name",
      cantidad: "RCPT Qty",
      precio: "USD Extended Price"
    });
  });

  it("formats AI column answers from profiles without sensitive values", () => {
    const profile = buildUploadStructureProfile({
      upload,
      records: [
        {
          raw_data: {
            MFG: "REAL_SUPPLIER_NAME",
            MPN: "REAL-MPN-ABC-123",
            "STOCK QTY": 77,
            "UNIT COST": 12345.67
          }
        }
      ]
    });

    const answer = formatColumnsAnswer(profile);
    const fields = formatDetectedFields(profile);

    expect(answer).toContain("MFG como fabricante");
    expect(answer).toContain("MPN como numero de parte");
    expect(fields).toContain("MPN como MPN");
    expect(answer).not.toContain("REAL_SUPPLIER_NAME");
    expect(answer).not.toContain("REAL-MPN-ABC-123");
    expect(fields).not.toContain("REAL_SUPPLIER_NAME");
  });

  it("sanitizes data quality issue messages before storing them in the profile", () => {
    const profile = buildUploadStructureProfile({
      upload,
      errorSummaries: [
        {
          error_type: "invalid_number",
          severity: "warning",
          message: "Bad cost value 12345.67 for customer REAL_CUSTOMER",
          occurrence_count: 3
        }
      ]
    });

    const serialized = JSON.stringify(profile);
    expect(serialized).toContain("Columna numerica con valores no normalizados.");
    expect(serialized).not.toContain("REAL_CUSTOMER");
    expect(serialized).not.toContain("12345.67");
  });
});
