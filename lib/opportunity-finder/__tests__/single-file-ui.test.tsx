// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "@/components/LanguageProvider";
import OpportunityFinder from "@/components/opportunity-finder/OpportunityFinder";

describe("Opportunity Finder mode selection", () => {
  it("starts with two explicit modes and changes mode without a reload", () => {
    const { container } = render(
      <LanguageProvider><OpportunityFinder /></LanguageProvider>
    );
    expect(screen.getByRole("button", { name: "Usar un archivo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Comparar dos archivos" })).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Usar un archivo" }));
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cambiar modo" }));
    fireEvent.click(screen.getByRole("button", { name: "Comparar dos archivos" }));
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
  });
});
