import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PROVISIONING_PASSWORD_ENV,
  ADMIN_ROTATION_PASSWORD_ENV,
  ADMIN_TARGETS,
  clearTemporaryProvisioningSecrets,
  executeProvisioning,
  parseProvisioningArgs,
  sanitizeProviderError,
  type ProvisioningGateway,
  type ProvisioningOptions,
  type SafeAuthUser
} from "../provision-admin-users";

const PROJECT_REF = "abcdefghijklmnopqrst";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const TARGET_A = ADMIN_TARGETS[0];
const TARGET_B = ADMIN_TARGETS[1];

function temporarySecret() {
  return ["mock", "temporary", "credential"].join("-");
}

function options(
  overrides: Partial<ProvisioningOptions> = {}
): ProvisioningOptions {
  return {
    mode: "apply",
    projectRef: PROJECT_REF,
    rotatePassword: false,
    targetEmail: TARGET_A.email,
    ...overrides
  };
}

function mockGateway(users: SafeAuthUser[] = []) {
  const gateway: ProvisioningGateway = {
    createUser: vi.fn(async (target) => ({ id: "created-user", email: target.email })),
    getProfile: vi.fn(async (userId) => ({
      id: userId,
      email: TARGET_A.email,
      role: "admin",
      is_active: true
    })),
    listUsers: vi.fn(async () => users),
    updateExistingUser: vi.fn(async (userId, target) => ({
      id: userId,
      email: target.email
    })),
    upsertProfile: vi.fn(async () => undefined)
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
  it("is a non-mutating dry-run with no arguments", () => {
    expect(parseProvisioningArgs([])).toEqual({
      mode: "dry-run",
      projectRef: undefined,
      rotatePassword: false,
      targetEmail: undefined
    });
  });

  it("makes zero calls for a new-user dry-run", async () => {
    const gateway = mockGateway([]);
    const deps = dependencies(gateway);

    const result = await executeProvisioning(
      options({ mode: "dry-run", projectRef: undefined }),
      deps
    );

    expect(result).toEqual({ action: "dry-run", changed: false });
    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
    expect(gateway.upsertProfile).not.toHaveBeenCalled();
  });

  it("makes zero calls for an existing-user dry-run", async () => {
    const gateway = mockGateway([{ id: "existing-user", email: TARGET_A.email }]);
    const deps = dependencies(gateway);

    await executeProvisioning(
      options({ mode: "dry-run", projectRef: undefined }),
      deps
    );

    expect(deps.createGateway).not.toHaveBeenCalled();
    expect(gateway.listUsers).not.toHaveBeenCalled();
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("preserves the password of an existing user on apply without rotation", async () => {
    const gateway = mockGateway([{ id: "existing-user", email: TARGET_A.email }]);
    const deps = dependencies(gateway);

    const result = await executeProvisioning(options(), deps);

    expect(result.action).toBe("updated");
    expect(gateway.getProfile).toHaveBeenCalledWith("existing-user");
    expect(gateway.updateExistingUser).toHaveBeenCalledTimes(1);
    expect(gateway.updateExistingUser).toHaveBeenCalledWith(
      "existing-user",
      TARGET_A,
      undefined
    );
    expect(gateway.upsertProfile).toHaveBeenCalledTimes(1);
  });

  it("aborts existing-user rotation when the temporary secret is absent", async () => {
    const gateway = mockGateway([{ id: "existing-user", email: TARGET_A.email }]);
    const deps = dependencies(gateway);

    await expect(
      executeProvisioning(options({ rotatePassword: true }), deps)
    ).rejects.toThrow("TEMPORARY_SECRET_REQUIRED");
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
    expect(gateway.upsertProfile).not.toHaveBeenCalled();
  });

  it("rotates exactly one existing target when the temporary secret is present", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway([
      { id: "target-a", email: TARGET_A.email },
      { id: "target-b", email: TARGET_B.email }
    ]);
    const deps = dependencies(gateway, {
      [ADMIN_ROTATION_PASSWORD_ENV]: secret
    });

    const result = await executeProvisioning(options({ rotatePassword: true }), deps);

    expect(result.action).toBe("rotated");
    expect(gateway.updateExistingUser).toHaveBeenCalledTimes(1);
    expect(gateway.updateExistingUser).toHaveBeenCalledWith("target-a", TARGET_A, secret);
    expect(gateway.upsertProfile).toHaveBeenCalledTimes(1);
    expect(gateway.createUser).not.toHaveBeenCalled();
  });

  it("never modifies target B when target A is selected", async () => {
    const gateway = mockGateway([
      { id: "target-a", email: TARGET_A.email },
      { id: "target-b", email: TARGET_B.email }
    ]);
    const deps = dependencies(gateway);

    await executeProvisioning(options(), deps);

    const updatedIds = vi.mocked(gateway.updateExistingUser).mock.calls.map(([id]) => id);
    expect(updatedIds).toEqual(["target-a"]);
    expect(updatedIds).not.toContain("target-b");
  });

  it("requires an external temporary secret to create a new user", async () => {
    const gateway = mockGateway([]);
    const deps = dependencies(gateway);

    await expect(executeProvisioning(options(), deps)).rejects.toThrow(
      "TEMPORARY_SECRET_REQUIRED"
    );
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.upsertProfile).not.toHaveBeenCalled();
  });

  it("creates only the exact new target with a temporary process secret", async () => {
    const secret = temporarySecret();
    const gateway = mockGateway([]);
    const deps = dependencies(gateway, {
      [ADMIN_PROVISIONING_PASSWORD_ENV]: secret
    });

    const result = await executeProvisioning(options(), deps);

    expect(result.action).toBe("created");
    expect(gateway.createUser).toHaveBeenCalledTimes(1);
    expect(gateway.createUser).toHaveBeenCalledWith(TARGET_A, secret);
    expect(gateway.upsertProfile).toHaveBeenCalledTimes(1);
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
  });

  it("rejects a missing, partial, or non-allowlisted target before creating a gateway", async () => {
    const gateway = mockGateway([]);
    const deps = dependencies(gateway);

    await expect(
      executeProvisioning(options({ targetEmail: TARGET_A.email.slice(0, 5) }), deps)
    ).rejects.toThrow("TARGET_NOT_ALLOWLISTED");
    expect(deps.createGateway).not.toHaveBeenCalled();
  });

  it("rejects a mismatched project ref before creating a gateway", async () => {
    const gateway = mockGateway([]);
    const deps = dependencies(gateway);

    await expect(
      executeProvisioning(options({ projectRef: "zyxwvutsrqponmlkjihg" }), deps)
    ).rejects.toThrow("PROJECT_REF_MISMATCH");
    expect(deps.createGateway).not.toHaveBeenCalled();
  });

  it("aborts when Auth returns more than one exact target", async () => {
    const gateway = mockGateway([
      { id: "duplicate-a", email: TARGET_A.email },
      { id: "duplicate-b", email: TARGET_A.email.toUpperCase() }
    ]);

    await expect(executeProvisioning(options(), dependencies(gateway))).rejects.toThrow(
      "AUTH_TARGET_AMBIGUOUS"
    );
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
  });

  it("inspects one exact target without changing Auth or profiles", async () => {
    const gateway = mockGateway([{ id: "existing-user", email: TARGET_A.email }]);
    const deps = dependencies(gateway);

    const result = await executeProvisioning(options({ mode: "inspect" }), deps);

    expect(result.action).toBe("inspect");
    expect(gateway.getProfile).toHaveBeenCalledTimes(1);
    expect(gateway.updateExistingUser).not.toHaveBeenCalled();
    expect(gateway.createUser).not.toHaveBeenCalled();
    expect(gateway.upsertProfile).not.toHaveBeenCalled();
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
    const gateway = mockGateway([]);
    gateway.listUsers = vi.fn(async () => {
      throw new Error(`provider token=${secret}`);
    });
    const deps = dependencies(gateway, {
      [ADMIN_ROTATION_PASSWORD_ENV]: secret
    });

    let message = "";
    try {
      await executeProvisioning(options({ mode: "inspect" }), deps);
    } catch (error) {
      message = sanitizeProviderError(error, deps.env);
    }

    expect(message).toContain("AUTH_LIST_FAILED");
    expect(message).toContain("[REDACTED]");
    expect(message.includes(secret)).toBe(false);
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
