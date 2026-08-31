// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import { DemoAccountBadge, DemoAccountNotice } from "@/components/clients/DemoAccount";
import { commerceCopy } from "@/lib/commerce/ui-i18n";

afterEach(cleanup);

describe("demo account disclosure", () => {
  it("marks a -demo account and shows the no-affiliation notice", () => {
    render(
      <LanguageProvider>
        <DemoAccountBadge accountName="Amazon-demo" />
        <DemoAccountNotice accountName="Amazon-demo" />
      </LanguageProvider>
    );
    expect(screen.getByText("DEMO")).toBeTruthy();
    expect(screen.getByText(/no implica relación comercial/i)).toBeTruthy();
  });

  it("renders no disclosure for a normal account name", () => {
    const view = render(
      <LanguageProvider>
        <DemoAccountBadge accountName="Ordinary Account" />
        <DemoAccountNotice accountName="Ordinary Account" />
      </LanguageProvider>
    );
    expect(view.container.textContent).toBe("");
  });

  it("provides the no-affiliation notice in EN, ES, and ZH", () => {
    expect(commerceCopy("en").demoNotice).toBe("Fictitious demo account \u2014 no commercial affiliation implied.");
    expect(commerceCopy("es").demoNotice).toBe("Cuenta ficticia de demostraci\u00f3n \u2014 no implica relaci\u00f3n comercial.");
    expect(commerceCopy("zh").demoNotice).toBe("\u865a\u6784\u6f14\u793a\u8d26\u6237 \u2014 \u4e0d\u4ee3\u8868\u4efb\u4f55\u5546\u4e1a\u5173\u8054\u3002");
  });
});
