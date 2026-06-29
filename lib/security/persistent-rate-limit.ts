import { createHash } from "node:crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/security/rateLimit";

interface PersistentRateLimitInput {
  action: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
  blockSeconds?: number;
}

export interface PersistentRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  persistent: boolean;
}

function keyHash(action: string, identifier: string) {
  return createHash("sha256").update(`${action}:${identifier.trim().toLowerCase()}`).digest("hex");
}

export async function checkPersistentRateLimit({
  action,
  identifier,
  limit,
  windowSeconds,
  blockSeconds = 60
}: PersistentRateLimitInput): Promise<PersistentRateLimitResult> {
  if (process.env.ENABLE_RATE_LIMITING === "false") {
    return { allowed: true, remaining: limit, resetAt: Date.now() + windowSeconds * 1000, persistent: false };
  }

  const service = createSupabaseServiceRoleClient();
  if (service) {
    const { data, error } = await service.rpc("consume_api_rate_limit", {
      input_key_hash: keyHash(action, identifier),
      input_action: action,
      input_limit: limit,
      input_window_seconds: windowSeconds,
      input_block_seconds: blockSeconds
    });

    const result = Array.isArray(data) ? data[0] : data;
    if (!error && result) {
      return {
        allowed: Boolean(result.allowed),
        remaining: Number(result.remaining ?? 0),
        resetAt: new Date(result.reset_at).getTime(),
        persistent: true
      };
    }
  }

  const local = checkRateLimit({
    key: `${action}:${keyHash(action, identifier)}`,
    limit,
    windowMs: windowSeconds * 1000
  });
  return { ...local, persistent: false };
}
