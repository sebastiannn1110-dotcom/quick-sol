import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  commerceRequestFingerprint,
  verifyCommerceIntakeSignature
} from "@/lib/commerce/auth";
import { commerceRfqIntakeSchema } from "@/lib/commerce/contracts";
import { commerceError, commerceNoStore, databaseErrorResponse } from "@/lib/commerce/http";
import { checkRateLimit, requestIp } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveClientId(
  service: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>,
  input: { clientId?: string | null; externalClientId?: string | null; contact: { email: string } }
) {
  if (input.clientId) {
    const { data } = await service.from("clients").select("id").eq("id", input.clientId).eq("status", "active").is("archived_at", null).maybeSingle();
    return data?.id ?? null;
  }
  if (input.externalClientId) {
    const { data } = await service.from("clients").select("id").eq("external_customer_id", input.externalClientId).eq("status", "active").is("archived_at", null).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data } = await service
    .from("commerce_client_details")
    .select("client_id")
    .ilike("contact_email", input.contact.email)
    .limit(1)
    .maybeSingle();
  if (!data?.client_id) return null;
  const { data: client } = await service
    .from("clients")
    .select("id")
    .eq("id", data.client_id)
    .eq("status", "active")
    .is("archived_at", null)
    .maybeSingle();
  return client?.id ?? null;
}

export async function POST(request: Request) {
  const rate = checkRateLimit({ key: `commerce-intake:${requestIp(request)}`, limit: 120, windowMs: 60_000 });
  if (!rate.allowed) return commerceError(429, "RATE_LIMITED", "Too many RFQ intake requests.");

  const rawBody = await request.text();
  const signature = verifyCommerceIntakeSignature(rawBody, request.headers);
  if (!signature.ok) {
    return commerceError(
      signature.reason === "unconfigured" ? 503 : 401,
      signature.reason === "unconfigured" ? "COMMERCE_UNAVAILABLE" : "INTEGRATION_AUTH_FAILED",
      signature.reason === "unconfigured"
        ? "RFQ intake authentication is not configured."
        : "RFQ intake signature is invalid or expired."
    );
  }
  const body = (() => {
    try { return JSON.parse(rawBody) as unknown; } catch { return null; }
  })();
  const parsed = commerceRfqIntakeSchema.safeParse(body);
  if (!parsed.success) {
    return commerceError(422, "VALIDATION_ERROR", "The RFQ intake payload is invalid.", parsed.error.flatten());
  }
  const service = createSupabaseServiceRoleClient();
  if (!service) return commerceError(503, "DATABASE_NOT_CONFIGURED", "RFQ intake is not configured.");
  try {
    const clientId = await resolveClientId(service, parsed.data);
    const fingerprint = commerceRequestFingerprint(parsed.data);
    const { data, error } = await service.rpc("ingest_commerce_rfq_v1", {
      input_external_rfq_id: parsed.data.externalRfqId,
      input_request_fingerprint: fingerprint,
      input_client_id: clientId,
      input_contact_snapshot: parsed.data.contact,
      input_items: parsed.data.items,
      input_source: parsed.data.source
    });
    if (error) return databaseErrorResponse(error);
    const result = data as Record<string, unknown>;
    return commerceNoStore(result, { status: result.idempotent === true ? 200 : 201 });
  } catch (error) {
    return databaseErrorResponse(error as { code?: string; message?: string });
  }
}
