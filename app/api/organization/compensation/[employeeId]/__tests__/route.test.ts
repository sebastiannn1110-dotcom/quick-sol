import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@/lib/types";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000002";
const UPDATED_AT = "2026-08-29T00:00:00.000Z";

function authContext(role: UserRole, businessRank: "owner" | "manager") {
  const organizationSelect = vi.fn(async () => ({
    data: [{
      profile_id: ACTOR_ID,
      manager_id: null,
      business_title: role === "admin" ? "Owner" : "Team member",
      business_rank: businessRank,
      department: "Executive",
      country: "Singapore",
      location: "Singapore",
      responsibilities: "DEMO",
      version: 1,
      updated_at: UPDATED_AT
    }],
    error: null
  }));
  const profilesEq = vi.fn(async () => ({
    data: [{
      id: ACTOR_ID,
      full_name: "Demo Actor",
      email: "actor@quiksol.demo.invalid",
      role,
      department: "Executive",
      region: "Global",
      avatar_path: null,
      is_active: true
    }],
    error: null
  }));
  const profilesSelect = vi.fn(() => ({ eq: profilesEq }));
  const compensationMaybeSingle = vi.fn(async () => ({
    data: {
      employee_id: EMPLOYEE_ID,
      amount: 220_000,
      currency: "USD",
      periodicity: "annual",
      updated_at: UPDATED_AT
    },
    error: null
  }));
  const compensationEq = vi.fn(() => ({ maybeSingle: compensationMaybeSingle }));
  const compensationSelect = vi.fn(() => ({ eq: compensationEq }));
  const from = vi.fn((table: string) => {
    if (table === "organization_members") return { select: organizationSelect };
    if (table === "profiles") return { select: profilesSelect };
    if (table === "employee_compensation") return { select: compensationSelect };
    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    context: {
      profile: {
        id: ACTOR_ID,
        full_name: "Demo Actor",
        email: "actor@quiksol.demo.invalid",
        role,
        department: "Executive",
        region: "Global",
        is_active: true,
        created_at: UPDATED_AT,
        updated_at: UPDATED_AT
      },
      supabase: { from },
      isDemoMode: false
    },
    from,
    compensationMaybeSingle
  };
}

async function requestCompensation(
  role: UserRole,
  businessRank: "owner" | "manager"
) {
  const fixture = authContext(role, businessRank);
  vi.doMock("@/lib/auth/context", () => ({
    getAuthContext: vi.fn(async () => fixture.context)
  }));
  const { GET } = await import("../route");
  const response = await GET(
    new Request(`https://app.test/api/organization/compensation/${EMPLOYEE_ID}`),
    { params: Promise.resolve({ employeeId: EMPLOYEE_ID }) }
  );
  return { ...fixture, response };
}

describe("GET /api/organization/compensation/:employeeId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([
    ["employee", "owner"],
    ["manager", "manager"]
  ] as const)("returns 403 for %s without querying compensation", async (role, rank) => {
    const { response, from, compensationMaybeSingle } = await requestCompensation(role, rank);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Compensation access is restricted.",
      code: "COMPENSATION_FORBIDDEN"
    });
    expect(from).not.toHaveBeenCalledWith("employee_compensation");
    expect(compensationMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns current compensation for an admin with owner business rank", async () => {
    const { response, from, compensationMaybeSingle } = await requestCompensation("admin", "owner");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      compensation: {
        employeeId: EMPLOYEE_ID,
        amount: 220_000,
        currency: "USD",
        periodicity: "annual",
        updatedAt: UPDATED_AT
      }
    });
    expect(from).toHaveBeenCalledWith("employee_compensation");
    expect(compensationMaybeSingle).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
