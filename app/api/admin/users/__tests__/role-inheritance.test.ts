import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  logAuditEvent: vi.fn(),
  getDemoPlatformData: vi.fn(async () => ({ profiles: [] })),
  createSupabaseAdminClient: vi.fn()
}));

vi.mock("@/lib/auth/context", () => ({
  requireAdmin: mocks.requireAdmin,
  logAuditEvent: mocks.logAuditEvent
}));

vi.mock("@/lib/platform/demoRepository", () => ({
  getDemoPlatformData: mocks.getDemoPlatformData
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/admin/users/route";

const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000840";

function provisioningDecision(
  overrides: Partial<{
    state: "NEW" | "EXISTING_PENDING" | "EXISTING_COMPLETED";
    intent_id: string;
    auth_user_id: string | null;
    role: "admin" | "manager" | "employee" | "super_admin_dev";
    status: string;
    attempt_count: number;
  }> = {}
) {
  return {
    state: "NEW" as const,
    intent_id: "00000000-0000-4000-8000-000000000082",
    auth_user_id: null,
    role: "employee" as const,
    status: "pending",
    attempt_count: 1,
    ...overrides
  };
}

function context(role: "admin" | "super_admin_dev", overrides: Record<string, unknown> = {}) {
  return {
    profile: { id: "00000000-0000-4000-8000-000000000001", role },
    isDemoMode: true,
    supabase: null,
    ...overrides
  };
}

describe("admin user management role inheritance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets Super Admin Dev use the normal admin users endpoint", async () => {
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev"));
    const response = await GET(new Request("https://app.test/api/admin/users"));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
  });

  it("does not let the admin screen demote the current Super Admin Dev", async () => {
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev"));
    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000001", role: "admin" })
    }));
    expect(response.status).toBe(403);
  });

  it("prevents a normal admin from modifying a Super Admin Dev profile", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "super_admin_dev" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = { from: vi.fn(() => builder) };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000002", email: "replacement@example.test" })
    }));

    expect(response.status).toBe(403);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects a normal admin attempting to create or promote Super Admin Dev", async () => {
    mocks.requireAdmin.mockResolvedValue(context("admin"));
    const createResponse = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "privileged@example.test",
        full_name: "Privileged Target",
        role: "super_admin_dev"
      })
    }));
    const promoteResponse = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000002",
        role: "super_admin_dev"
      })
    }));

    expect(createResponse.status).toBe(403);
    expect(promoteResponse.status).toBe(403);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns an authorization rejection before creating an intent or Auth user", async () => {
    mocks.requireAdmin.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(401);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("requires a valid Idempotency-Key before provisioning", async () => {
    const supabase = { rpc: vi.fn() };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "A valid Idempotency-Key UUID header is required.",
      code: "INVALID_IDEMPOTENCY_KEY"
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns a stable retryable result when the atomic begin response is lost", async () => {
    const supabase = {
      rpc: vi.fn(async () => {
        throw new Error("connection reset after commit");
      })
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "PROVISIONING_RETRYABLE"
    }));
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns the stable retryable contract when Auth service access is unavailable after begin", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({ data: provisioningDecision(), error: null }))
    };
    mocks.createSupabaseAdminClient.mockReturnValue(null);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY"),
      code: "PROVISIONING_RETRYABLE"
    });
    expect(supabase.rpc).toHaveBeenCalledOnce();
  });

  it("replays a completed operation without calling Auth or returning a password", async () => {
    const userId = "00000000-0000-4000-8000-000000000006";
    const supabase = {
      rpc: vi.fn(async () => ({
        data: provisioningDecision({
          state: "EXISTING_COMPLETED",
          auth_user_id: userId,
          role: "manager",
          status: "completed",
          attempt_count: 2
        }),
        error: null
      }))
    };
    const service = { auth: { admin: { createUser: vi.fn() } } };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "manager"
      })
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(service.auth.admin.createUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      created: true,
      reused: true,
      recovered: true,
      provisioningStatus: "completed",
      user: { id: userId, role: "manager", is_active: true },
      temporaryPasswordAvailable: false
    });
    expect(result).not.toHaveProperty("temporaryPassword");
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("recovers success after an ambiguous Auth error without echoing a client password", async () => {
    const userId = "00000000-0000-4000-8000-000000000006";
    const supabase = {
      rpc: vi
        .fn()
        .mockResolvedValueOnce({ data: provisioningDecision(), error: null })
        .mockResolvedValueOnce({
          data: provisioningDecision({
            state: "EXISTING_COMPLETED",
            auth_user_id: userId,
            status: "completed",
            attempt_count: 2
          }),
          error: null
        })
    };
    const service = {
      auth: { admin: { createUser: vi.fn(async () => { throw new Error("connection reset"); }) } }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee",
        password: "client-only-password"
      })
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(service.auth.admin.createUser).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      created: true,
      reused: true,
      recovered: true,
      temporaryPasswordAvailable: false
    }));
    expect(result).not.toHaveProperty("temporaryPassword");
    expect(JSON.stringify(supabase.rpc.mock.calls)).not.toContain("client-only-password");
  });

  it("maps a stable reconciliation mismatch discovered during Auth recovery", async () => {
    const supabase = {
      rpc: vi
        .fn()
        .mockResolvedValueOnce({ data: provisioningDecision(), error: null })
        .mockResolvedValueOnce({
          data: null,
          error: { code: "QS846", message: "private mismatch detail" }
        })
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: null },
            error: { message: "ambiguous provider error" }
          }))
        }
      }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "RECONCILIATION_MISMATCH"
    }));
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(service.auth.admin.createUser).toHaveBeenCalledOnce();
  });

  it("completes an existing pending intent and marks the direct result reused", async () => {
    const intentId = "00000000-0000-4000-8000-000000000084";
    const supabase = {
      rpc: vi.fn(async () => ({
        data: provisioningDecision({
          state: "EXISTING_PENDING",
          intent_id: intentId,
          attempt_count: 2
        }),
        error: null
      }))
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: { id: "00000000-0000-4000-8000-000000000006" } },
            error: null
          }))
        }
      }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toEqual(expect.objectContaining({
      created: true,
      reused: true,
      recovered: false,
      temporaryPasswordAvailable: true
    }));
    expect(result.temporaryPassword).toEqual(expect.any(String));
    expect(service.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      user_metadata: expect.objectContaining({ quiksol_provisioning_intent_id: intentId })
    }));
  });

  it.each([
    ["QS841", "IDEMPOTENCY_KEY_REUSED"],
    ["QS842", "USER_ALREADY_PROVISIONED"],
    ["QS843", "PROVISIONING_IN_PROGRESS"],
    ["QS846", "RECONCILIATION_MISMATCH"]
  ])("maps provisioning conflict %s to stable 409 code %s", async (sqlState, publicCode) => {
    const supabase = {
      rpc: vi.fn(async () => ({ data: null, error: { code: sqlState, message: "private detail" } }))
    };
    const service = { auth: { admin: { createUser: vi.fn() } } };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ code: publicCode }));
    expect(service.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("lets an admin provision an allowed role through intent metadata without a Profile write", async () => {
    const intentId = "00000000-0000-4000-8000-000000000082";
    const supabase = {
      rpc: vi.fn(async () => ({
        data: provisioningDecision({ intent_id: intentId, role: "manager" }),
        error: null
      }))
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: { id: "00000000-0000-4000-8000-000000000006" } },
            error: null
          }))
        }
      },
      from: vi.fn()
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: " Employee@Example.Test ",
        full_name: " Employee ",
        role: "manager",
        department: "Operations"
      })
    }));

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "begin_user_provisioning_v2",
      expect.objectContaining({
        operation_idempotency_key: IDEMPOTENCY_KEY,
        requested_email: "employee@example.test",
        requested_full_name: "Employee",
        requested_role: "manager"
      })
    );
    expect(service.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: "employee@example.test",
      user_metadata: {
        full_name: "Employee",
        quiksol_provisioning_intent_id: intentId
      }
    }));
    const createAttributes = service.auth.admin.createUser.mock.calls[0][0];
    expect(createAttributes).not.toHaveProperty("app_metadata.quiksol_provisioning_intent_id");
    expect(createAttributes.user_metadata).not.toHaveProperty("role");
    expect(createAttributes.user_metadata).not.toHaveProperty("department");
    expect(createAttributes.user_metadata).not.toHaveProperty("region");
    expect(createAttributes.user_metadata).not.toHaveProperty("is_active");
    expect(service.from).not.toHaveBeenCalled();
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      created: true,
      reused: false,
      recovered: false,
      provisioningStatus: "completed",
      temporaryPasswordAvailable: true,
      user: {
        id: "00000000-0000-4000-8000-000000000006",
        role: "manager",
        is_active: true
      }
    }));
  });

  it("never echoes a client-provided password after direct Auth success", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({ data: provisioningDecision(), error: null }))
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: { id: "00000000-0000-4000-8000-000000000006" } },
            error: null
          }))
        }
      }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee",
        password: "client-only-password"
      })
    }));
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(service.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      password: "client-only-password"
    }));
    expect(result.temporaryPasswordAvailable).toBe(false);
    expect(result).not.toHaveProperty("temporaryPassword");
    expect(JSON.stringify(supabase.rpc.mock.calls)).not.toContain("client-only-password");
  });

  it("lets Super Admin Dev create a privileged profile through the explicit audited API", async () => {
    const intentId = "00000000-0000-4000-8000-000000000083";
    const supabase = {
      rpc: vi.fn(async () => ({
        data: provisioningDecision({
          intent_id: intentId,
          role: "super_admin_dev"
        }),
        error: null
      }))
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: { id: "00000000-0000-4000-8000-000000000007" } },
            error: null
          }))
        }
      }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "privileged@example.test",
        full_name: "Privileged Target",
        role: "super_admin_dev"
      })
    }));

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("begin_user_provisioning_v2", {
      operation_idempotency_key: IDEMPOTENCY_KEY,
      requested_email: "privileged@example.test",
      requested_full_name: "Privileged Target",
      requested_role: "super_admin_dev",
      requested_department: null,
      requested_region: null,
      requested_is_active: true,
      requested_bio: null,
      requested_job_title: null
    });
    expect(service.auth.admin.createUser).toHaveBeenCalledWith(expect.objectContaining({
      user_metadata: {
        full_name: "Privileged Target",
        quiksol_provisioning_intent_id: intentId
      }
    }));
    expect(service.auth.admin.createUser.mock.calls[0][0]).not.toHaveProperty(
      "app_metadata.quiksol_provisioning_intent_id"
    );
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("does not call Auth or emit a success audit when intent authorization loses a race", async () => {
    const supabase = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "42501", message: "ADMIN_REQUIRED: private detail" }
      }))
    };
    const service = {
      auth: { admin: { createUser: vi.fn() } }
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You do not have permission to provision this user.",
      code: "ADMIN_MUTATION_FORBIDDEN"
    });
    expect(service.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("does not write a Profile or emit a success audit when Auth creation fails", async () => {
    const intentId = "00000000-0000-4000-8000-000000000084";
    const supabase = {
      rpc: vi.fn(async () => ({
        data: provisioningDecision({
          state: "EXISTING_PENDING",
          intent_id: intentId,
          attempt_count: 2
        }),
        error: null
      }))
    };
    const service = {
      auth: {
        admin: {
          createUser: vi.fn(async () => ({
            data: { user: null },
            error: { message: "provider detail" }
          }))
        }
      },
      from: vi.fn()
    };
    mocks.createSupabaseAdminClient.mockReturnValue(service);
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await POST(new Request("https://app.test/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY },
      body: JSON.stringify({
        email: "employee@example.test",
        full_name: "Employee",
        role: "employee"
      })
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    await expect(response.json()).resolves.toEqual({
      error: "User creation has an uncertain result. Retry with the same idempotency key.",
      code: "PROVISIONING_RETRYABLE"
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(service.from).not.toHaveBeenCalled();
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("routes a Super Admin Dev promotion through the audited database RPC", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null })),
      in: vi.fn()
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    builder.in.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: { id: "00000000-0000-4000-8000-000000000008", role: "super_admin_dev" },
        error: null
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev", {
      isDemoMode: false,
      supabase
    }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000008",
        role: "super_admin_dev"
      })
    }));

    expect(response.status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000008",
      profile_patch: { role: "super_admin_dev" },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "admin_changed_role",
      "profile",
      "00000000-0000-4000-8000-000000000008",
      { role: "super_admin_dev" }
    );
  });

  it("maps a rejected PATCH invariant to a stable 409 without success audit or count precheck", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "admin" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "QS821", message: "LAST_EFFECTIVE_ADMIN_REQUIRED" }
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("super_admin_dev", { isDemoMode: false, supabase }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000009",
        role: "employee"
      })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "At least one effective administrator must remain.",
      code: "LAST_EFFECTIVE_ADMIN_REQUIRED"
    });
    expect(builder.select).toHaveBeenCalledOnce();
    expect(builder.select).toHaveBeenCalledWith("role");
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000009",
      profile_patch: { role: "employee" },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("keeps unknown PATCH database failures sanitized as 500 without success audit", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "XX000", message: "LAST_EFFECTIVE_ADMIN_REQUIRED: private database detail" }
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000010",
        department: "Operations"
      })
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Unable to update user." });
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("maps a PATCH authorization race to a sanitized 403 without success audit", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "42501", message: "ADMIN_REQUIRED: private database detail" }
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await PATCH(new Request("https://app.test/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "00000000-0000-4000-8000-000000000013",
        department: "Operations"
      })
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You do not have permission to perform this administrative change.",
      code: "ADMIN_MUTATION_FORBIDDEN"
    });
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000013",
      profile_patch: { department: "Operations" },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("routes DELETE soft-deactivation through v2 and audits only after success", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({ data: { is_active: false }, error: null }))
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await DELETE(new Request("https://app.test/api/admin/users", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000011" })
    }));

    expect(response.status).toBe(200);
    expect(builder.select).toHaveBeenCalledOnce();
    expect(builder.select).toHaveBeenCalledWith("role");
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000011",
      profile_patch: { is_active: false },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      "admin_deactivated_employee",
      "profile",
      "00000000-0000-4000-8000-000000000011",
      { softDelete: true }
    );
  });

  it("maps a rejected DELETE invariant to 409 without a false success audit", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "admin" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "QS821", message: "LAST_EFFECTIVE_ADMIN_REQUIRED" }
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await DELETE(new Request("https://app.test/api/admin/users", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000012" })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "At least one effective administrator must remain.",
      code: "LAST_EFFECTIVE_ADMIN_REQUIRED"
    });
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000012",
      profile_patch: { is_active: false },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("maps a DELETE authorization race to a sanitized 403 without success audit", async () => {
    const builder = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn(async () => ({ data: { role: "employee" }, error: null }))
    };
    builder.select.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    const supabase = {
      from: vi.fn(() => builder),
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "42501", message: "SUPER_ADMIN_DEV_REQUIRED: private database detail" }
      }))
    };
    mocks.requireAdmin.mockResolvedValue(context("admin", { isDemoMode: false, supabase }));

    const response = await DELETE(new Request("https://app.test/api/admin/users", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "00000000-0000-4000-8000-000000000014" })
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "You do not have permission to perform this administrative change.",
      code: "ADMIN_MUTATION_FORBIDDEN"
    });
    expect(supabase.rpc).toHaveBeenCalledWith("update_profile_admin_v2", {
      target_profile_id: "00000000-0000-4000-8000-000000000014",
      profile_patch: { is_active: false },
      confirm_self_deactivate: false
    });
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });
});
