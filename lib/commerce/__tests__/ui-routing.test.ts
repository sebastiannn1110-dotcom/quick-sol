import { describe, expect, it } from "vitest";
import { isCommerceWorkspacePath } from "@/proxy";
import { commerceCopy } from "@/lib/commerce/ui-i18n";

describe("Commerce workspace route guard", () => {
  it("allows the RFQ and Quote editor route families without widening the rest of /admin", () => {
    expect(isCommerceWorkspacePath("/admin/rfqs")).toBe(true);
    expect(isCommerceWorkspacePath("/admin/rfqs/00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isCommerceWorkspacePath("/admin/quotes/00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isCommerceWorkspacePath("/admin/users")).toBe(false);
    expect(isCommerceWorkspacePath("/admin/employee-analytics")).toBe(false);
  });
});

describe("Commerce UI languages", () => {
  it("ships the required RFQ and Quote workflow copy in ES, EN, and ZH", () => {
    expect(commerceCopy("es").rfqInbox).toBe("Solicitudes de cotización");
    expect(commerceCopy("en").newRfqReceived).toBe("New RFQ received");
    expect(commerceCopy("zh").createQuote).toBe("创建报价");
    expect(commerceCopy("zh").pricingRequired).toBe("需要定价");
    expect(commerceCopy("es").demoNotice).toContain("no implica relación comercial");
  });
});
