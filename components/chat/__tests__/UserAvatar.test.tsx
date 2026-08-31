// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import UserAvatar from "@/components/chat/UserAvatar";

afterEach(cleanup);

describe("UserAvatar", () => {
  const jasonName = "Jason Boss \u2014 DEMO";
  const mayaName = "Maya Torres \u2014 DEMO";
  const oliviaName = "Olivia Mercer \u2014 DEMO";

  it("renders only Jason's permanent J even when a stale photo path is supplied", () => {
    const { container } = render(
      <UserAvatar
        name={jasonName}
        avatarPath="/demo/people/jason.webp"
        size="xl"
      />
    );

    const avatar = container.querySelector("[data-avatar-size='xl']");
    expect(avatar?.getAttribute("data-avatar-state")).toBe("initials");
    expect(screen.queryByRole("img", { name: jasonName })).toBeNull();
    expect(screen.queryByText("JB")).toBeNull();
    expect(screen.getByText("J")).toBeTruthy();
  });

  it("keeps another employee's configured demo image", () => {
    const { container } = render(
      <UserAvatar name={mayaName} avatarPath="/demo/people/maya.webp" />
    );

    expect(screen.getByRole("img", { name: mayaName }).getAttribute("src"))
      .toBe("/demo/people/maya.webp");
    expect(container.firstElementChild?.getAttribute("data-avatar-state")).toBe("image");
  });

  it("recovers when the avatar path changes after a failed image", () => {
    const { rerender } = render(
      <UserAvatar name={oliviaName} avatarPath="/demo/people/olivia.webp" />
    );
    fireEvent.error(screen.getByRole("img", { name: oliviaName }));

    rerender(<UserAvatar name={mayaName} avatarPath="/demo/people/maya.webp" />);

    expect(screen.getByRole("img", { name: mayaName }).getAttribute("src"))
      .toBe("/demo/people/maya.webp");
    expect(screen.queryByText("MT")).toBeNull();
  });
});
