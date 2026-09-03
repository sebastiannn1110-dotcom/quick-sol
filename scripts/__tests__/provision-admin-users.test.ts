import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PROVISIONING_PASSWORD_ENV,
  ADMIN_ROTATION_PASSWORD_ENV,
  ADMIN_TARGETS,
  clearTemporaryProvisioningSecrets,
  executeProvisioning,
  parseProvisioningArgs,
  resolveAdminTarget,
  sanitizeProviderError,
  type BeginProvisioningResult,
  type ProvisioningGateway,
  type ProvisioningOptions,
  type SafeAuthUser,
  type SafeProfileMetadata
} from "../provision-admin-users";

const PROJECT_REF = "abcdefghijklmnopqrst";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const TARGET_A = ADMIN_TARGETS[0];
const TARGET_B = ADMIN_TARGETS[1];
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000084";
const INTENT_ID = "00000000-0000-4000-8000-000000000083";
const AUTH_USER_ID = "00000000-0000-4000-8000-000000000085";

function temporarySecret() {
  return ["mock", "temporary", "credential"].join("-");
}

function options(overrides: Partial<ProvisioningOptions> = {}): ProvisioningOptions {
  return {
    mode: "apply",
    idempotencyKey: IDEMPOTENCY_KEY,
    projectRef: PROJECT_REF,
    rotatePassword: false,
    targetEmail: TARGET_A.email,
    ...overrides
  };
}

function beginResult(
  overrides: Partial<BeginProvisioningResult> = {}
): BeginProvisioningResult {
  return {
    state: "NEW",
    intentId: INTENT_ID,
    authUserId: null,
    role: TARGET_A.role,
    status: "pending",
    attemptCount: 1,
    ...overrides
  };
}

function matchingUser(id = AUTH_USER_ID): SafeAuthUser {
  return {
    id,
    email: TARGET_A.email,
    authActive: true,
    emailConfirmed: true
  };
}

function matchingProfile(id = AUTH_USER_ID): SafeProfileMetadata {
  return {
    id,
    email: TARGET_A.email,
    role: TARGET_A.role,
    is_active: true
  };
}

function mockGateway(users: SafeAuthUser[] = []) {
  const gateway: ProvisioningGateway = {
    beginProvisioning: vi.fn(async () => beginResult()),
    createUser: vi.fn(async (target) => ({ id: AUTH_USER_ID, email: target.email })),
    getProfile: vi.fn(async (userId) => matchingProfile(userId)),
    listUsers: vi.fn(async () => users),
    updateExistingUser: vi.fn(async (userId) => ({ id: userId, email: TARGET_A.email }))
  };
  return gateway;
}

function dependencies(
  gateway: ProvisioningGateway,
  env: NodeJS.ProcessEnv = {}
) {
  return {
    createGateway: vi.fn(() => gateway),
    env,
    log: vi.fn<(message: string) => void>(),
    supabaseUrl: SUPABASE_URL
  };
}

describe("safe admin provisioning", () => {
  it("allowlists the full-access demo identity with the maximum technical role", () => {
    expect(resolveAdminTarget("USER1.TEST.DEMO.COM@DEMO.INVALID")).toMatchObject({
      email: "user1.test.demo.com@demo.invalid",
      fullName: "user1.test.demo.com",
      role: "super_admin_dev"
    });
  });

  it("is a non-mutating dry-run with no arguments", () => {
    expect(parseProvisioningArgs([])).toEqual({
      mode: "dry-run",
      idempotencyKey: undefined,
      projectRef: undefined,
      rotatePassword: false,
      targetEmail: undefined
    });
  });

  it("requires one valid stable idempotency key for creation apply", () => {
    const base = [
      "--apply",
      `--target-email=${TARGET_A.email}`,
      `--project-ref=${PROJECT_REF}`
    ];

    expect(() => parseProvisioningArgs(base)).toThrow("IDEMPOTENCY_KEY_REQUIRED");
    expect(() => parseProvisioningArgs([...base, "--idempotency-key=not-a-uuid"])).toThrow(
      "IDEMPOTENCY_KEY_INVALID"
    );
    expect(() => parseProvisioningArgs([
      ...base,
      `--idempotency-key=${IDEMPOTENCY_KEY}`,
      `--idempotency-key=${AUTH_USER_ID}`
    ])).toThrow("DUPLICATE_FLAG: --idempotency-key");

    expect(parseProvisioningArgs([...base, `--idempotency-key=${IDEMPOTENCY_KEY}`]))
      .toMatchObject({ idempotencyKey: IDEMPOTENCY_KEY });
  });

  it("does not require an idempotency key for explicit password rotation", () => {
    expect(parseProvisioningArgs([
      "--apply",
      "--rotate-password",
      `--target-email=${TARGET_A.email}`,
      `--project-ref=${PROJECT_REF}`
    ])).toMatchObject({ idempotencyKey: undefined, rotatePassword: true });
  });

  it("makes zero calls for dry-run", async () => {
    const gateway = mockGateway();
    const deps = dependencies(gateway);

    const result = await executeProvisioning(
      options({ mode: "dry-run", idempotencyKey: undefined, projectRef: undefined }),
      deps
    );

    expect(result).toEqual({ action: "dry-run", changed: false });
    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(gateway.beginProvisioning).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("inspects one exact target without mutation", async () => {
    const gateway = mockGateway([matchingUser()]);
    const deps = dependencies(gateway);

    const result = await executeProvisioning(
      options({ mode: "inspect", idempotencyKey: undefined }),
      deps
    );

    expect(result.action).toBe("inspect");
    expect(gateway.listUsers).toHaveBeenCalled();
    expect(gateway.getProfile).toHaveBeenCalledWith(AUTH_USER_ID);
    expect(gateway.beginProvisioning).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("creates a NEW operation with the v2 intent and never lists Auth first", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway([matchingUser()]);
    const deps = dependencies(gateway, {
      [ADMIN_PROVISIONING_PASSWORD_ENV]: secret
    });

    const result = await executeProvisioning(options(), deps);

    expect(result).toMatchObject({ action: "created", changed: true, reused: false });
    expect(gateway.listUsers).not.toHaveBeenCalled();
    expect(gateway.getProfile).not.toHaveBeenCalled();
    expect(gateway.beginProvisioning).toHaveBeenCalledTimes(1);
    expect(gateway.beginProvisioning).toHaveBeenCalledWith(TARGET_A, IDEMPOTENCY_KEY);
    expect(gateway.createUser).toHaveBeenCalledWith(TARGET_A, secret, INTENT_ID);
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("reuses an EXISTING_PENDING operation and the same intent", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway();
    vi.mocked(gateway.beginProvisioning).mockResolvedValueOnce(beginResult({
      state: "EXISTING_PENDING",
      attemptCount: 2
    }));

    const result = await executeProvisioning(options(), dependencies(gateway, {
      [ADMIN_PROVISIONING_PASSWORD_ENV]: secret
    }));

    expect(result).toMatchObject({ action: "created", changed: true, reused: true });
    expect(gateway.createUser).toHaveBeenCalledTimes(1);
    expect(gateway.createUser).toHaveBeenCalledWith(TARGET_A, secret, INTENT_ID);
  });

  it("replays EXISTING_COMPLETED without a password, Auth listing, or createUser", async () => {
    const gateway = mockGateway([matchingUser()]);
    vi.mocked(gateway.beginProvisioning).mockResolvedValueOnce(beginResult({
      state: "EXISTING_COMPLETED",
      authUserId: AUTH_USER_ID,
      status: "completed",
      attemptCount: 2
    }));

    const result = await executeProvisioning(options(), dependencies(gateway));

    expect(result).toMatchObject({
      action: "created",
      changed: false,
      reused: true,
      userId: AUTH_USER_ID
    });
    expect(gateway.beginProvisioning).toHaveBeenCalledTimes(1);
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.listUsers).not.toHaveBeenCalled();
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("recovers a committed Auth creation after an ambiguous provider error", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway();
    vi.mocked(gateway.beginProvisioning)
      .mockResolvedValueOnce(beginResult())
      .mockResolvedValueOnce(beginResult({
        state: "EXISTING_COMPLETED",
        authUserId: AUTH_USER_ID,
        status: "completed",
        attemptCount: 2
      }));
    gateway.createUser = vi.fn(async () => {
      throw new Error(`connection reset token=${secret}`);
    });

    const result = await executeProvisioning(options(), dependencies(gateway, {
      [ADMIN_PROVISIONING_PASSWORD_ENV]: secret
    }));

    expect(result).toMatchObject({
      action: "created",
      changed: false,
      recovered: true,
      reused: true,
      userId: AUTH_USER_ID
    });
    expect(gateway.beginProvisioning).toHaveBeenCalledTimes(2);
    expect(gateway.createUser).toHaveBeenCalledTimes(1);
  });

  it("returns a stable sanitized retryable error while the intent remains pending", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway();
    vi.mocked(gateway.beginProvisioning)
      .mockResolvedValueOnce(beginResult())
      .mockResolvedValueOnce(beginResult({ state: "EXISTING_PENDING", attemptCount: 2 }));
    gateway.createUser = vi.fn(async () => {
      throw new Error(`timeout password=${secret}`);
    });

    let message = "";
    try {
      await executeProvisioning(options(), dependencies(gateway, {
        [ADMIN_PROVISIONING_PASSWORD_ENV]: secret
      }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("PROVISIONING_RETRYABLE");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
    expect(gateway.beginProvisioning).toHaveBeenCalledTimes(2);
    expect(gateway.createUser).toHaveBeenCalledTimes(1);
  });

  it("leaves a new or pending intent retryable when the creation secret is absent", async () => {
    const gateway = mockGateway();

    await expect(executeProvisioning(options(), dependencies(gateway))).rejects.toThrow(
      "TEMPORARY_SECRET_REQUIRED"
    );
    expect(gateway.beginProvisioning).toHaveBeenCalledTimes(1);
    expect(gateway.createUser).not.toHaveBeenCalled();
  });

  it("rotates only an exact active and confirmed Auth/Profile pair", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway([matchingUser()]);
    const result = await executeProvisioning(
      options({ idempotencyKey: undefined, rotatePassword: true }),
      dependencies(gateway, { [ADMIN_ROTATION_PASSWORD_ENV]: secret })
    );

    expect(result).toMatchObject({ action: "rotated", changed: true, userId: AUTH_USER_ID });
    expect(gateway.updateExistingUser).toHaveBeenCalledTimes(1);
    expect(gateway.updateExistingUser).toHaveBeenCalledWith(AUTH_USER_ID, secret);
    expect(gateway.beginProvisioning).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing Profile", user: matchingUser(), profile: null },
    {
      name: "mismatched Profile role",
      user: matchingUser(),
      profile: { ...matchingProfile(), role: "employee" }
    },
    {
      name: "inactive Auth",
      user: { ...matchingUser(), authActive: false },
      profile: matchingProfile()
    },
    {
      name: "unconfirmed Auth",
      user: { ...matchingUser(), emailConfirmed: false },
      profile: matchingProfile()
    }
  ])("fails rotation closed for $name", async ({ user, profile }) => {
    const gateway = mockGateway([user]);
    gateway.getProfile = vi.fn(async () => profile);

    await expect(executeProvisioning(
      options({ idempotencyKey: undefined, rotatePassword: true }),
      dependencies(gateway, { [ADMIN_ROTATION_PASSWORD_ENV]: temporarySecret() })
    )).rejects.toThrow("ROTATION_RECONCILIATION_REQUIRED");

    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
    expect(gateway.beginProvisioning).not.toHaveBeenCalled();
  });

  it("requires the rotation secret only after the exact target is validated", async () => {
    const gateway = mockGateway([matchingUser()]);

    await expect(executeProvisioning(
      options({ idempotencyKey: undefined, rotatePassword: true }),
      dependencies(gateway)
    )).rejects.toThrow("TEMPORARY_SECRET_REQUIRED");
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("rejects a missing or ambiguous rotation target without mutation", async () => {
    const missing = mockGateway([]);
    await expect(executeProvisioning(
      options({ idempotencyKey: undefined, rotatePassword: true }),
      dependencies(missing)
    )).rejects.toThrow("ROTATION_TARGET_MISSING");

    const ambiguous = mockGateway([
      matchingUser(AUTH_USER_ID),
      { ...matchingUser(INTENT_ID), email: TARGET_A.email.toUpperCase() }
    ]);
    await expect(executeProvisioning(
      options({ mode: "inspect", idempotencyKey: undefined }),
      dependencies(ambiguous)
    )).rejects.toThrow("AUTH_TARGET_AMBIGUOUS");
    expect(missing.updateExistingUser).not.toHaveBeenCalled();
    expect(ambiguous.updateExistingUser).not.toHaveBeenCalled();
  });

  it("rejects unsafe target and project inputs before creating a gateway", async () => {
    const gateway = mockGateway();
    const deps = dependencies(gateway);

    await expect(executeProvisioning(
      options({ targetEmail: TARGET_A.email.slice(0, 5) }),
      deps
    )).rejects.toThrow("TARGET_NOT_ALLOWLISTED");
    await expect(executeProvisioning(
      options({ projectRef: "zyxwvutsrqponmlkjihg" }),
      deps
    )).rejects.toThrow("PROJECT_REF_MISMATCH");
    expect(deps.createGateway).not.toHaveBeenCalled();
  });

  it("never targets a second allowlisted account during exact inspection", async () => {
    const gateway = mockGateway([
      matchingUser(AUTH_USER_ID),
      { ...matchingUser(INTENT_ID), email: TARGET_B.email }
    ]);

    const result = await executeProvisioning(
      options({ mode: "inspect", idempotencyKey: undefined }),
      dependencies(gateway)
    );

    expect(result).toMatchObject({ existingUser: { id: AUTH_USER_ID } });
    expect(gateway.getProfile).toHaveBeenCalledTimes(1);
    expect(gateway.getProfile).toHaveBeenCalledWith(AUTH_USER_ID);
  });

  it("rejects CLI password values and requires apply for rotation", () => {
    expect(() => parseProvisioningArgs(["--password=not-accepted"])).toThrow(
      "CLI_PASSWORD_FORBIDDEN"
    );
    expect(() => parseProvisioningArgs(["--rotate-password"])).toThrow(
      "ROTATION_REQUIRES_APPLY"
    );
    expect(() => parseProvisioningArgs(["--apply"])).toThrow("TARGET_REQUIRED");
  });

  it("sanitizes provider errors and known environment secrets", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway();
    gateway.listUsers = vi.fn(async () => {
      throw new Error(`provider token=${secret}`);
    });
    const deps = dependencies(gateway, {
      [ADMIN_ROTATION_PASSWORD_ENV]: secret
    });

    let message = "";
    try {
      await executeProvisioning(
        options({ mode: "inspect", idempotencyKey: undefined }),
        deps
      );
    } catch (error) {
      message = sanitizeProviderError(error, deps.env);
    }

    expect(message).toContain("AUTH_LIST_FAILED");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(secret);
  });

  it("removes temporary provisioning secrets from the process environment", () => {
    const env: NodeJS.ProcessEnv = {
      [ADMIN_PROVISIONING_PASSWORD_ENV]: temporarySecret(),
      [ADMIN_ROTATION_PASSWORD_ENV]: temporarySecret()
    };

    clearTemporaryProvisioningSecrets(env);

    expect(env[ADMIN_PROVISIONING_PASSWORD_ENV]).toBeUndefined();
    expect(env[ADMIN_ROTATION_PASSWORD_ENV]).toBeUndefined();
  });
});
