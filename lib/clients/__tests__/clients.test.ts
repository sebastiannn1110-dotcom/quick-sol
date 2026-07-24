import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clientCapabilities, isUuid, parseClientWriteInput } from "@/lib/clients/clients";
import { redactSensitiveFieldsForRole } from "@/lib/security/permissions";

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Phase 7.1 client access and scope", () => {
  it("keeps employee read-only while manager and admin can manage clients", () => {
    expect(clientCapabilities("employee")).toMatchObject({
      canManage: false,
      canAssignUploads: false,
      canArchive: false,
      canViewPrivateIdentification: false
    });
    expect(clientCapabilities("manager")).toMatchObject({
      canManage: true,
      canAssignUploads: true,
      canArchive: true,
      canViewPrivateIdentification: true
    });
    expect(clientCapabilities("admin").canManage).toBe(true);
  });

  it("validates client writes and UUID relationships", () => {
    expect(parseClientWriteInput({ name: "Synthetic Account", website: "https://example.test" })).toMatchObject({
      name: "Synthetic Account",
      website: "https://example.test"
    });
    expect(parseClientWriteInput({ name: "", website: "javascript:alert(1)" })).toBeNull();
    expect(isUuid("7e9093e5-6881-40f3-9aee-7a9b495b301c")).toBe(true);
    expect(isUuid("Amazon")).toBe(false);
  });

  it("lets employee see the assigned account name but redacts extracted and financial fields", () => {
    const result = redactSensitiveFieldsForRole({
      accountClients: [{ id: "client-1", name: "Synthetic Account" }],
      customerNeedName: "Extracted Customer",
      supplierName: "Extracted Supplier",
      mpn: "001234",
      requiredQty: 10,
      cost: 5,
      price: 8,
      gp_rate: 0.2,
      commission: 1,
      raw_data: { MPN: "001234", cost: 5 }
    }, "employee");

    expect(result.accountClients).toEqual([{ id: "client-1", name: "Synthetic Account" }]);
    expect(result.mpn).toBe("001234");
    expect(result.requiredQty).toBe(10);
    expect(result.customerNeedName).toBeNull();
    expect(result.supplierName).toBeNull();
    expect(result.cost).toBeNull();
    expect(result.price).toBeNull();
    expect(result.gp_rate).toBeNull();
    expect(result.commission).toBeNull();
    expect(result.raw_data.cost).toBeNull();
  });

  it("applies clientId and upload scope on the backend", () => {
    const service = source("lib/opportunities/service.ts");
    const loader = source("lib/stock-needs/data-source.ts");
    const detailRoute = source("app/api/clients/[clientId]/opportunities/route.ts");

    expect(service).toContain("getClientDetail");
    expect(service).toContain("listClientUploadIds");
    expect(service).toContain("uploadIds");
    expect(detailRoute).toContain("clientId }");
    expect(detailRoute).toContain("loadSalesOpportunities");
    expect(loader).toContain("options.uploadIds !== null && !options.uploadIds.length");
    expect(loader).toContain('.is("archived_at", null)');
  });

  it("keeps private identification in a manager-only table and uses scoped RLS assignments", () => {
    const migration = source("supabase/migrations/20260723190000_clients_opportunities_access.sql");
    expect(migration).toContain("create table if not exists public.client_private_details");
    expect(migration).toContain("client_private_details_select_manager");
    expect(migration).toContain("public.can_manage_clients()");
    expect(migration).toContain("public.can_read_upload(batch.uploaded_by)");
    expect(migration).toContain("unique (upload_batch_id)");
    expect(migration).not.toContain("delete from public.clients");
  });
});
