import { describe, expect, it } from "vitest";
import {
  canViewCosts,
  canViewCustomerDetails,
  canViewGp,
  canViewSensitivePricing,
  canViewSupplierDetails,
  getRolePermissions,
  questionRequestsSensitiveCommercialData,
  redactSensitiveFieldsForLlm,
  redactSensitiveFieldsForRole
} from "@/lib/security/permissions";

const record = {
  id: "record-1",
  mpn: "SAFE-MPN-1",
  qty: 10,
  status: "open",
  supplier_name: "Sensitive Supplier",
  customer: "Sensitive Customer",
  po: "PO-123",
  cost: 5.25,
  price: 8.5,
  gp_rate: 0.22,
  comments: "internal note",
  upload_batches: {
    original_file_name: "Demo_File.xlsx"
  },
  raw_data: {
    MPN: "SAFE-MPN-1",
    "STOCK QTY": 10,
    MFG: "Sensitive Manufacturer",
    "UNIT COST": 5.25,
    PriceBook: 8.5,
    GlobalPrice: 8.75,
    "USD Extended Price": 85,
    GP: 3.25,
    "GP rate": "22%",
    PO: "PO-123",
    "internal notes": "do not show",
    "Global Customer Name": "Sensitive Customer"
  }
};

describe("role permissions and sensitive field redaction", () => {
  it("allows admins to view complete commercial fields", () => {
    expect(getRolePermissions("admin")).toMatchObject({
      canViewSensitivePricing: true,
      canViewCosts: true,
      canViewGp: true,
      canViewSupplierDetails: true,
      canViewCustomerDetails: true
    });
    expect(redactSensitiveFieldsForRole(record, "admin")).toEqual(record);
  });

  it("redacts costs, pricing, GP, PO and notes for managers while preserving supplier and customer context", () => {
    const redacted = redactSensitiveFieldsForRole(record, "manager");

    expect(canViewCosts("manager")).toBe(false);
    expect(canViewSensitivePricing("manager")).toBe(false);
    expect(canViewGp("manager")).toBe(false);
    expect(canViewSupplierDetails("manager")).toBe(true);
    expect(canViewCustomerDetails("manager")).toBe(true);
    expect(redacted).toMatchObject({
      mpn: "SAFE-MPN-1",
      qty: 10,
      supplier_name: "Sensitive Supplier",
      customer: "Sensitive Customer",
      cost: null,
      price: null,
      gp_rate: null,
      po: null,
      comments: null
    });
    expect(redacted.raw_data).toMatchObject({
      MPN: "SAFE-MPN-1",
      "STOCK QTY": 10,
      MFG: "Sensitive Manufacturer",
      "UNIT COST": null,
      PriceBook: null,
      GlobalPrice: null,
      "USD Extended Price": null,
      GP: null,
      "GP rate": null,
      PO: null,
      "internal notes": null,
      "Global Customer Name": "Sensitive Customer"
    });
  });

  it("redacts supplier and customer details for employees but keeps MPN, quantity, status and file origin", () => {
    const redacted = redactSensitiveFieldsForRole(record, "employee");

    expect(redacted).toMatchObject({
      id: "record-1",
      mpn: "SAFE-MPN-1",
      qty: 10,
      status: "open",
      supplier_name: null,
      customer: null,
      cost: null,
      price: null,
      gp_rate: null,
      upload_batches: {
        original_file_name: "Demo_File.xlsx"
      }
    });
    expect(redacted.raw_data).toMatchObject({
      MPN: "SAFE-MPN-1",
      "STOCK QTY": 10,
      MFG: null,
      "Global Customer Name": null
    });
  });

  it("creates an LLM-safe copy without commercial sensitive fields", () => {
    const redacted = redactSensitiveFieldsForLlm(record);

    expect(JSON.stringify(redacted)).not.toContain("Sensitive Supplier");
    expect(JSON.stringify(redacted)).not.toContain("Sensitive Customer");
    expect(JSON.stringify(redacted)).not.toContain("5.25");
    expect(JSON.stringify(redacted)).not.toContain("PO-123");
    expect(redacted.mpn).toBe("SAFE-MPN-1");
  });

  it("detects sensitive commercial questions", () => {
    expect(questionRequestsSensitiveCommercialData("Cual es el costo y GP rate?")).toBe(true);
    expect(questionRequestsSensitiveCommercialData("Que MPN tienen falta de stock?")).toBe(false);
  });
});
