// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ClientImage from "@/components/clients/ClientImage";

describe("ClientImage", () => {
  afterEach(cleanup);

  it("prioritizes the signed logo and finishes its loading state", () => {
    render(
      <ClientImage
        logoUrl="https://signed.example.test/logo"
        authorizedIdentificationImageUrl="https://signed.example.test/identification"
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    const image = screen.getByRole("img", { name: "Synthetic Client" });
    expect(image.getAttribute("src")).toBe("https://signed.example.test/logo");
    expect(screen.getByTestId("client-image").getAttribute("data-client-image-state")).toBe("loading");

    fireEvent.load(image);
    expect(screen.getByTestId("client-image").getAttribute("data-client-image-state")).toBe("ready");
  });

  it("uses an authorized identification image when no logo exists", () => {
    render(
      <ClientImage
        logoUrl={null}
        authorizedIdentificationImageUrl="https://signed.example.test/identification"
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    expect(screen.getByRole("img", { name: "Synthetic Client" }).getAttribute("src"))
      .toBe("https://signed.example.test/identification");
  });

  it("falls back from a broken logo to the authorized identification image", () => {
    render(
      <ClientImage
        logoUrl="https://signed.example.test/broken-logo"
        authorizedIdentificationImageUrl="https://signed.example.test/identification"
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    fireEvent.error(screen.getByRole("img", { name: "Synthetic Client" }));

    expect(screen.getByRole("img", { name: "Synthetic Client" }).getAttribute("src"))
      .toBe("https://signed.example.test/identification");
  });

  it("shows the placeholder after every authorized image source fails", () => {
    render(
      <ClientImage
        logoUrl="https://signed.example.test/broken-logo"
        authorizedIdentificationImageUrl="https://signed.example.test/broken-identification"
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    fireEvent.error(screen.getByRole("img", { name: "Synthetic Client" }));
    fireEvent.error(screen.getByRole("img", { name: "Synthetic Client" }));

    expect(screen.queryByRole("img", { name: "Synthetic Client" })).toBeNull();
    expect(screen.getByTestId("client-image-placeholder")).toBeTruthy();
    expect(screen.getByTestId("client-image").getAttribute("data-client-image-state")).toBe("placeholder");
  });

  it("shows the placeholder when the server provides no authorized image", () => {
    render(
      <ClientImage
        logoUrl={null}
        authorizedIdentificationImageUrl={null}
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    expect(screen.queryByRole("img", { name: "Synthetic Client" })).toBeNull();
    expect(screen.getByTestId("client-image-placeholder")).toBeTruthy();
  });

  it("resets loading and displays a newly signed URL after an image update", () => {
    const { rerender } = render(
      <ClientImage
        logoUrl="https://signed.example.test/logo-v1"
        authorizedIdentificationImageUrl={null}
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );
    fireEvent.load(screen.getByRole("img", { name: "Synthetic Client" }));
    expect(screen.getByTestId("client-image").getAttribute("data-client-image-state")).toBe("ready");

    rerender(
      <ClientImage
        logoUrl="https://signed.example.test/logo-v2"
        authorizedIdentificationImageUrl={null}
        alt="Synthetic Client"
        className="h-24 w-24"
      />
    );

    expect(screen.getByRole("img", { name: "Synthetic Client" }).getAttribute("src"))
      .toBe("https://signed.example.test/logo-v2");
    expect(screen.getByTestId("client-image").getAttribute("data-client-image-state")).toBe("loading");
  });
});
