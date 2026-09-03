import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS,
  ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
  ELECTRONIC_PARTS_DEMO_SEED_MARKER
} from "@/lib/demo/employee-scope";

const getAuthContext = vi.fn();

const retainedNames = [
  "Olivia Mercer — DEMO",
  "Daniel Brooks — DEMO",
  "Maya Torres — DEMO",
  "Jordan Lee — DEMO",
  "Sofia Ramirez — DEMO",
  "Lucas Almeida — DEMO",
  "Emma Clarke — DEMO",
  "Priya Nair — DEMO",
  "Ethan Tan — DEMO",
  "Li Na — DEMO",
  "Haruto Sato — DEMO",
  "Min-jun Park — DEMO",
  "Chloe Wilson — DEMO",
  "Lukas Weber — DEMO",
  "Hannah Fischer — DEMO",
  "Camille Laurent — DEMO",
  "Oliver Bennett — DEMO",
  "Lucia Garcia — DEMO",
  "Lin Wei — DEMO"
] as const;

function profile(input: {
  id: string;
  fullName: string;
  email: string;
  bio: string | null;
  isActive?: boolean;
  avatarPath?: string | null;
}) {
  return {
    id: input.id,
    full_name: input.fullName,
    email: input.email,
    role: "employee",
    department: "Sales",
    region: "Global",
    avatar_path: input.avatarPath ?? "demo/people/test.webp",
    bio: input.bio,
    job_title: "Demo employee",
    is_active: input.isActive ?? true,
    created_at: "2026-08-29T12:00:00.000Z",
    updated_at: "2026-08-29T12:00:00.000Z"
  };
}

describe("GET /api/employees", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("@/lib/auth/context", () => ({ getAuthContext }));
  });

  it("reduces the 127-row historical directory to the exact canonical 19", async () => {
    const retained = ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.map((email, index) => profile({
      id: `retained-${index}`,
      fullName: retainedNames[index],
      email,
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      avatarPath: `demo/people/${index}.webp`
    }));
    const historical = Array.from({ length: 105 }, (_, index) => profile({
      id: `historical-${index}`,
      fullName: `Historical ${index}`,
      email: `historical-${index}@example.com`,
      bio: null
    }));
    const owner = profile({
      id: "owner",
      fullName: "user.test.demo.com",
      email: ELECTRONIC_PARTS_DEMO_OWNER_EMAIL,
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER,
      avatarPath: null
    });
    const jason = profile({
      id: "jason",
      fullName: "Jason Boss",
      email: "jasonboss@quiksol.com",
      bio: ELECTRONIC_PARTS_DEMO_SEED_MARKER
    });
    const wrongMarker = profile({
      id: "wrong-marker",
      fullName: "Maya Torres historical alias",
      email: ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS[2],
      bio: "ANOTHER_DATASET"
    });
    const directory = [...retained, ...historical, owner, jason, wrongMarker];
    expect(directory).toHaveLength(127);

    const rpc = vi.fn(async (name: string) => name === "list_employee_directory"
      ? { data: directory, error: null }
      : { data: directory.map((row) => ({ id: row.id, upload_count: 0, record_count: 0, last_upload: null })), error: null });
    getAuthContext.mockResolvedValue({
      user: { id: "owner" },
      profile: { ...owner, role: "admin", business_rank: "owner" },
      supabase: { rpc },
      isDemoMode: false,
      requestMeta: {
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        route: "/api/employees",
        traceId: "trace-id",
        requestId: "request-id"
      }
    });

    const { GET } = await import("../route");
    const response = await GET(new Request("https://app.test/api/employees"));
    const payload = await response.json() as { employees: typeof retained };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-electronic-parts-employee-scope")).toBe("19");
    expect(payload.employees).toHaveLength(19);
    expect(payload.employees.map((employee) => employee.full_name)).toEqual(retainedNames);
    expect(payload.employees.every((employee) => employee.avatar_path != null)).toBe(true);
    expect(payload.employees.every((employee) => employee.bio === ELECTRONIC_PARTS_DEMO_SEED_MARKER)).toBe(true);
    expect(payload.employees.every((employee) => ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS.includes(employee.email as typeof ELECTRONIC_PARTS_DEMO_EMPLOYEE_EMAILS[number]))).toBe(true);
    expect(payload.employees.some((employee) => employee.email === ELECTRONIC_PARTS_DEMO_OWNER_EMAIL)).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/jason|historical/i);
  });
});
