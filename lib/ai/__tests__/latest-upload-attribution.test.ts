import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/context";
import type { UserRole } from "@/lib/types";
import { getLatestUploadAttribution } from "@/lib/ai/database-tools";
import { assistantMessage, localizeToolSummary } from "@/lib/ai/messages";

function authContext(role: UserRole, supabase: unknown): AuthContext {
  return {
    user: null,
    supabase: supabase as AuthContext["supabase"],
    isDemoMode: false,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      full_name: "Synthetic Employee",
      email: "synthetic@demo.invalid",
      role,
      department: "Sales",
      region: "Americas",
      is_active: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    },
    requestMeta: {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      route: "/api/assistant",
      traceId: "trace",
      requestId: "request"
    }
  };
}

function supabaseFixture(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "neq", "order", "limit", "eq"] as const) {
    query[method] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  const client = { from: vi.fn(() => query) };
  return { client, query };
}

const visibleUpload = {
  original_file_name: "DEMO_SALES_NEEDS_2026-08.xlsx",
  status: "completed_with_warnings",
  created_at: "2026-08-29T12:34:00.000Z",
  profiles: { full_name: "Maya Torres" },
  id: "private-id-must-not-leave-tool",
  uploaded_by: "private-owner-id",
  stored_file_path: "private/path/file.xlsx",
  email: "private@demo.invalid"
};

describe("latest upload attribution tool", () => {
  it.each([
    ["employee", "own"],
    ["manager", "team"],
    ["admin", "company"],
    ["super_admin_dev", "company"]
  ] as const)("returns only the safe projection for %s scope", async (role, scope) => {
    const { client, query } = supabaseFixture(visibleUpload);
    const output = await getLatestUploadAttribution(authContext(role, client));

    expect(client.from).toHaveBeenCalledWith("upload_batches");
    expect(query.select).toHaveBeenCalledWith(
      "original_file_name, status, created_at, profiles(full_name)"
    );
    expect(query.neq).toHaveBeenCalledWith("status", "archived");
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(query.limit).toHaveBeenCalledWith(1);
    if (role === "employee") {
      expect(query.eq).toHaveBeenCalledWith(
        "uploaded_by",
        "00000000-0000-4000-8000-000000000001"
      );
    } else {
      expect(query.eq).not.toHaveBeenCalled();
    }

    expect(output).toEqual(expect.objectContaining({
      ok: true,
      tool: "getLatestUploadAttribution",
      scope,
      total: 1,
      empty: false,
      deterministic: true,
      data: {
        item: {
          fileName: "DEMO_SALES_NEEDS_2026-08.xlsx",
          uploadedAt: "2026-08-29T12:34:00.000Z",
          status: "completed_with_warnings",
          uploaderDisplayName: "Maya Torres"
        }
      }
    }));
    expect(JSON.stringify(output.data)).not.toMatch(
      /private-id|private-owner|private\/path|private@demo\.invalid|uploaded_by|stored_file_path/i
    );
  });

  it("returns an empty authorized result when no visible upload exists", async () => {
    const { client, query } = supabaseFixture(null);
    const output = await getLatestUploadAttribution(authContext("employee", client));

    expect(output).toEqual(expect.objectContaining({
      ok: false,
      tool: "getLatestUploadAttribution",
      scope: "own",
      data: { item: null },
      empty: true,
      deterministic: true
    }));
    expect(query.eq).toHaveBeenCalledWith(
      "uploaded_by",
      "00000000-0000-4000-8000-000000000001"
    );
  });

  it.each([
    ["es", "La carga autorizada m\u00e1s reciente", "completado con advertencias"],
    ["en", "The latest authorized upload", "completed with warnings"],
    ["zh", "\u6700\u8fd1\u4e00\u6b21\u6388\u6743\u4e0a\u4f20", "\u5df2\u5b8c\u6210\uff0c\u4f46\u6709\u8b66\u544a"]
  ] as const)("renders the same safe facts in %s", async (language, prefix, status) => {
    const { client } = supabaseFixture(visibleUpload);
    const output = await getLatestUploadAttribution(authContext("manager", client));
    const answer = localizeToolSummary(output, language);

    expect(answer).toContain(prefix);
    expect(answer).toContain("Maya Torres");
    expect(answer).toContain("DEMO_SALES_NEEDS_2026-08.xlsx");
    expect(answer).toContain("2026");
    expect(answer).toContain(status);
    expect(answer).not.toMatch(/private@|private\/path|private-owner/i);
  });

  it.each(["es", "en", "zh"] as const)("uses the localized no-data response in %s", (language) => {
    const emptyResult = {
      ok: false,
      tool: "getLatestUploadAttribution" as const,
      scope: "own" as const,
      data: { item: null },
      summary: "",
      empty: true,
      deterministic: true
    };

    expect(localizeToolSummary(emptyResult, language)).toBe(assistantMessage(language, "noData"));
  });
});
