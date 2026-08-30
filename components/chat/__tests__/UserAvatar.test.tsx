// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import UserAvatar from "@/components/chat/UserAvatar";

afterEach(cleanup);

describe("UserAvatar", () => {
  it("renders Jason's allowlisted demo photo and keeps initials hidden when it loads", () => {
    const { container } = render(
      <UserAvatar
        name="Jason Boss — DEMO"
        avatarPath="/demo/people/jason.webp"
        size="xl"
      />
    );

    const image = screen.getByRole("img", { name: "Jason Boss — DEMO" });
    expect(image.getAttribute("src")).toBe("/demo/people/jason.webp");
    fireEvent.load(image);

    const avatar = container.querySelector("[data-avatar-size='xl']");
    expect(avatar?.getAttribute("data-avatar-state")).toBe("image");
    expect(screen.queryByText("JB")).toBeNull();
  });

  it("shows visible initials when the selected image fails", () => {
    const { container } = render(
      <UserAvatar name="Jason Boss — DEMO" avatarPath="/demo/people/jason.webp" />
    );

    fireEvent.error(screen.getByRole("img", { name: "Jason Boss — DEMO" }));

    expect(screen.queryByRole("img", { name: "Jason Boss — DEMO" })).toBeNull();
    expect(screen.getByText("JB")).toBeTruthy();
    expect(container.firstElementChild?.getAttribute("data-avatar-state")).toBe("initials");
  });

  it("recovers when the avatar path changes after a failed image", () => {
    const { rerender } = render(
      <UserAvatar name="Jason Boss — DEMO" avatarPath="/demo/people/jason.webp" />
    );
    fireEvent.error(screen.getByRole("img", { name: "Jason Boss — DEMO" }));

    rerender(<UserAvatar name="Maya Torres — DEMO" avatarPath="/demo/people/maya.webp" />);

    expect(screen.getByRole("img", { name: "Maya Torres — DEMO" }).getAttribute("src"))
      .toBe("/demo/people/maya.webp");
    expect(screen.queryByText("MT")).toBeNull();
  });
});
