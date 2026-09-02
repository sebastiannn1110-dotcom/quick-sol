// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TeamStructure from "@/components/organization/TeamStructure";
import { DEMO_DATA_MANIFEST } from "@/scripts/demo-data-manifest";
import type {
  BusinessRank,
  OrganizationDirectory,
  OrganizationMember
} from "@/lib/organization/contracts";
import type { UserRole } from "@/lib/types";

vi.mock("@/components/LanguageProvider", () => ({
  useLanguage: () => ({ language: "en", locale: "en-US" })
}));

function member(
  profileId: string,
  managerId: string | null,
  name: string,
  businessTitle: string,
  businessRank: BusinessRank,
  department: string,
  country: string,
  technicalRole: UserRole
): OrganizationMember {
  return {
    profileId,
    managerId,
    name,
    email: `${profileId}@quiksol.demo.invalid`,
    businessTitle,
    businessRank,
    department,
    country,
    location: `${country} — DEMO`,
    responsibilities: "QUIKSOL_DEMO_DATA_V1",
    version: 1,
    updatedAt: "2026-08-29T00:00:00.000Z",
    technicalRole,
    region: department === "Sales — DEMO" ? "Americas — DEMO" : "Global — DEMO",
    avatarPath: profileId === "maya" ? "/demo/people/maya.webp" : null,
    canEdit: false
  };
}

const MEMBERS: OrganizationMember[] = [
  member("demo-owner", null, "user.test.demo.com", "Owner / Administrator", "owner", "Executive — DEMO", "Global", "admin"),
  member("olivia", "demo-owner", "Olivia Mercer — DEMO", "Chief Operating Officer — DEMO", "executive", "Executive — DEMO", "United States", "admin"),
  member("daniel", "olivia", "Daniel Brooks — DEMO", "Sales Manager Americas — DEMO", "manager", "Sales — DEMO", "United States", "manager"),
  member("maya", "daniel", "Maya Torres — DEMO", "Sales Representative — DEMO", "salesperson", "Sales — DEMO", "Colombia", "employee"),
  member("jordan", "daniel", "Jordan Lee — DEMO", "Account Executive — DEMO", "salesperson", "Sales — DEMO", "Canada", "employee"),
  member("lin", "olivia", "Lin Wei — DEMO", "Sourcing Manager Asia — DEMO", "sourcing_manager", "Sourcing — DEMO", "Singapore", "manager")
];

function directory(technicalRole: UserRole, canReadCompensation: boolean): OrganizationDirectory {
  return {
    actor: {
      id: technicalRole === "super_admin_dev" ? "superdev" : technicalRole,
      technicalRole,
      businessRank: technicalRole === "admin" ? "owner" : null,
      canEditGlobal: technicalRole === "admin" || technicalRole === "super_admin_dev",
      canReadCompensation
    },
    members: MEMBERS
  };
}

function completeDemoDirectory(): OrganizationDirectory {
  return {
    actor: {
      id: "demo-manager",
      technicalRole: "manager",
      businessRank: "manager",
      canEditGlobal: false,
      canReadCompensation: false
    },
    members: DEMO_DATA_MANIFEST.people.map((person) => ({
      profileId: person.key,
      managerId: person.managerKey,
      name: person.fullName,
      email: person.email,
      businessTitle: person.title,
      businessRank: person.organizationRank,
      department: person.department,
      country: person.country,
      location: person.location,
      responsibilities: person.responsibilities,
      version: 1,
      updatedAt: DEMO_DATA_MANIFEST.fixedTimestamp,
      technicalRole: person.technicalRole,
      region: person.region,
      avatarPath: person.avatarPath,
      canEdit: false
    }))
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => payload)
  } as unknown as Response;
}

function baseFetch(directoryPayload: OrganizationDirectory) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/organization") return Promise.resolve(jsonResponse(directoryPayload));
    if (url === "/api/employee-analytics") {
      return Promise.resolve(jsonResponse({ analytics: { metrics: [] } }));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Team Structure filters and compensation", () => {
  it("renders 27 employee photos while the demo owner uses only U", async () => {
    vi.stubGlobal("fetch", baseFetch(completeDemoDirectory()));
    render(<TeamStructure />);

    const treeHeading = await screen.findByRole("heading", { name: "Organization tree" });
    const treePhotos = within(treeHeading.closest("section")!).getAllByRole("img");
    const sources = treePhotos.map((photo) => photo.getAttribute("src"));

    expect(treePhotos).toHaveLength(27);
    expect(new Set(sources).size).toBe(27);
    const treeSection = treeHeading.closest("section")!;
    const ownerInitials = within(treeSection).getByLabelText(/user\.test\.demo\.com.* initials/);
    expect(ownerInitials.textContent).toBe("U");
  });

  it("shows the owner's compact and xl avatars as U without an image", async () => {
    vi.stubGlobal("fetch", baseFetch(directory("manager", false)));
    const { container } = render(<TeamStructure />);

    const treeHeading = await screen.findByRole("heading", { name: "Organization tree" });
    const treeSection = treeHeading.closest("section")!;
    const treeInitials = within(treeSection).getByLabelText(/user\.test\.demo\.com.* initials/);

    const panelAvatar = container.querySelector("[data-avatar-size='xl']");
    expect(panelAvatar).toBeTruthy();
    expect(treeInitials.textContent).toBe("U");
    expect(treeInitials.closest("[data-avatar-size]")?.getAttribute("data-avatar-size")).toBe("md");
    expect(panelAvatar?.getAttribute("data-avatar-state")).toBe("initials");
    expect(within(panelAvatar as HTMLElement).queryByRole("img")).toBeNull();
    expect(within(panelAvatar as HTMLElement).getByText("U")).toBeTruthy();
  });

  it("combines filters, keeps only required ancestors, and clears every filter", async () => {
    vi.stubGlobal("fetch", baseFetch(directory("manager", false)));
    render(<TeamStructure />);

    const treeHeading = await screen.findByRole("heading", { name: "Organization tree" });
    const treeSection = treeHeading.closest("section")!;

    fireEvent.change(screen.getByLabelText("Search employee"), { target: { value: "maya@quiksol" } });
    fireEvent.change(screen.getByLabelText("Country filter"), { target: { value: "Colombia" } });
    fireEvent.change(screen.getByLabelText("Department filter"), { target: { value: "Sales — DEMO" } });
    fireEvent.change(screen.getByLabelText("Business rank filter"), { target: { value: "salesperson" } });
    fireEvent.change(screen.getByLabelText("Manager / team filter"), { target: { value: "daniel" } });

    await waitFor(() => expect(within(treeSection).getByText("Maya Torres — DEMO")).toBeTruthy());
    expect(within(treeSection).getByText("user.test.demo.com")).toBeTruthy();
    expect(within(treeSection).getByText("Olivia Mercer — DEMO")).toBeTruthy();
    expect(within(treeSection).getByText("Daniel Brooks — DEMO")).toBeTruthy();
    expect(within(treeSection).queryByText("Jordan Lee — DEMO")).toBeNull();
    expect(within(treeSection).queryByText("Lin Wei — DEMO")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await within(treeSection).findByText("Jordan Lee — DEMO")).toBeTruthy();
    expect(within(treeSection).getByText("Lin Wei — DEMO")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Search employee").value).toBe("");
  });

  it.each([
    ["manager" as const],
    ["employee" as const]
  ])("does not request or render compensation for a %s", async (role) => {
    const fetchMock = baseFetch(directory(role, false));
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamStructure />);

    await screen.findByRole("heading", { name: "Organization tree" });
    await Promise.resolve();

    expect(fetchMock.mock.calls.some(([target]) => String(target).includes("/compensation/"))).toBe(false);
    expect(screen.queryByText("Current compensation")).toBeNull();
  });

  it.each([
    ["admin" as const],
    ["super_admin_dev" as const]
  ])("requests and renders current compensation for an authorized %s", async (role) => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/organization") return Promise.resolve(jsonResponse(directory(role, true)));
      if (url === "/api/employee-analytics") return Promise.resolve(jsonResponse({ analytics: { metrics: [] } }));
      if (url === "/api/organization/compensation/demo-owner") {
        return Promise.resolve(jsonResponse({
          compensation: {
            employeeId: "demo-owner",
            amount: 220000,
            currency: "USD",
            periodicity: "annual",
            updatedAt: "2026-08-29T00:00:00.000Z"
          }
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamStructure />);

    expect(await screen.findByText("US$ 220,000 / year")).toBeTruthy();
    expect(screen.getByText("Current compensation")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([target]) => String(target).includes("/compensation/")).length).toBe(1);
  });

  it("aborts and clears an obsolete compensation request when selection changes", async () => {
    let firstSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/organization") return Promise.resolve(jsonResponse(directory("admin", true)));
      if (url === "/api/employee-analytics") return Promise.resolve(jsonResponse({ analytics: { metrics: [] } }));
      if (url === "/api/organization/compensation/demo-owner") {
        firstSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          firstSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (url === "/api/organization/compensation/maya") {
        return Promise.resolve(jsonResponse({
          compensation: {
            employeeId: "maya",
            amount: 78000,
            currency: "USD",
            periodicity: "annual",
            updatedAt: "2026-08-29T00:00:00.000Z"
          }
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamStructure />);

    const treeHeading = await screen.findByRole("heading", { name: "Organization tree" });
    const treeSection = treeHeading.closest("section")!;
    await waitFor(() => expect(firstSignal).not.toBeNull());
    fireEvent.click(within(treeSection).getByRole("button", { name: /Maya Torres/ }));

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(await screen.findByText("US$ 78,000 / year")).toBeTruthy();
    expect(screen.queryByText("US$ 220,000 / year")).toBeNull();
  });

  it("never renders a previously loaded salary under a newly selected employee", async () => {
    let resolveMaya!: (response: Response) => void;
    const mayaResponse = new Promise<Response>((resolve) => {
      resolveMaya = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/organization") return Promise.resolve(jsonResponse(directory("admin", true)));
      if (url === "/api/employee-analytics") return Promise.resolve(jsonResponse({ analytics: { metrics: [] } }));
      if (url === "/api/organization/compensation/demo-owner") {
        return Promise.resolve(jsonResponse({
          compensation: {
            employeeId: "demo-owner",
            amount: 220000,
            currency: "USD",
            periodicity: "annual",
            updatedAt: "2026-08-29T00:00:00.000Z"
          }
        }));
      }
      if (url === "/api/organization/compensation/maya") return mayaResponse;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TeamStructure />);

    expect(await screen.findByText("US$ 220,000 / year")).toBeTruthy();
    const treeHeading = screen.getByRole("heading", { name: "Organization tree" });
    fireEvent.click(within(treeHeading.closest("section")!).getByRole("button", { name: /Maya Torres/ }));

    expect(screen.queryByText("US$ 220,000 / year")).toBeNull();
    expect(await screen.findByText("Loading compensation...")).toBeTruthy();
    await act(async () => {
      resolveMaya(jsonResponse({
        compensation: {
          employeeId: "maya",
          amount: 78000,
          currency: "USD",
          periodicity: "annual",
          updatedAt: "2026-08-29T00:00:00.000Z"
        }
      }));
      await Promise.resolve();
    });
    expect(await screen.findByText("US$ 78,000 / year")).toBeTruthy();
  });
});
