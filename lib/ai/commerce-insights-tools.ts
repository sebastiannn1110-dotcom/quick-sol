import type { AuthContext } from "@/lib/auth/context";
import { getAiPermissionScope } from "@/lib/ai/ai-permissions";
import type { AiToolResult } from "@/lib/ai/database-tools";
import { normalizeBusinessQuestion } from "@/lib/ai/business-intent";
import { listCommerceManageableClientIds } from "@/lib/commerce/service";


type JsonRow = Record<string, unknown>;
type InsightToolName = "client_lookup";
export type ClientInsightMode = "count" | "search" | "owner" | "quotes";

function relationOne(value: unknown): JsonRow {
  if (Array.isArray(value)) return (value[0] ?? {}) as JsonRow;
  return value && typeof value === "object" ? value as JsonRow : {};
}

function text(value: unknown, max = 200) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F<>`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function result(
  context: AuthContext,
  tool: InsightToolName,
  data: unknown,
  rows: unknown[],
  options: { total: number; empty?: boolean; truncated?: boolean; summary: string }
): AiToolResult {
  return {
    ok: !options.empty,
    tool,
    scope: getAiPermissionScope(context).mode,
    total: options.total,
    rows,
    data,
    summary: options.summary,
    empty: Boolean(options.empty),
    truncated: Boolean(options.truncated),
    deterministic: true
  };
}

function extractDemoAccount(question: string) {
  return normalizeBusinessQuestion(question).match(
    /(?:^|\s)([\p{L}\p{N}][\p{L}\p{N}-]*-demo)(?=$|\s|[./])/u
  )?.[1] ?? "";
}

function clientSearchTerm(question: string) {
  const demo = extractDemoAccount(question);
  if (demo) return demo;
  const candidate = question.match(
    /(?:busca|buscar|search|find)\s+(?:el\s+cliente\s+|cliente\s+|customer\s+)?([\p{L}\p{N}][\p{L}\p{N} ._-]{1,80})/iu
  )?.[1];
  return text(candidate, 80).replace(/[%_]/g, "");
}

export function parseClientInsightMode(question: string): ClientInsightMode {
  const value = normalizeBusinessQuestion(question);
  if (/\b(?:quote|quotes|cotizacion|cotizaciones)\b/u.test(value) || value.includes("\u62a5\u4ef7")) return "quotes";
  if (/\b(?:quien atiende|quien gestiona|who handles|who manages|assigned seller|vendedor asignado)\b/u.test(value) || value.includes("\u8c01\u8d1f\u8d23")) {
    return "owner";
  }
  if (/\b(?:cuantos clientes|cuantas cuentas|how many clients|how many customers)\b/u.test(value) || value.includes("\u591a\u5c11\u5ba2\u6237")) {
    return "count";
  }
  return "search";
}

function safeClient(row: JsonRow) {
  return {
    name: text(row.name, 200),
    isDemoAccount: /-demo$/i.test(text(row.name, 200))
  };
}

async function canReadCommerceClient(context: AuthContext, clientId: string) {
  const { data, error } = await context.supabase!.rpc("commerce_can_read_client_v2", {
    target_client_id: clientId
  });
  if (error) throw error;
  return data === true;
}

async function manageableClientRows(context: AuthContext, search: string) {
  const ids = await listCommerceManageableClientIds(context.supabase!);
  if (!ids.length) return { ids, rows: [] as JsonRow[] };
  const rows: JsonRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    let query = context.supabase!
      .from("clients")
      .select("id,name")
      .eq("status", "active")
      .is("archived_at", null)
      .in("id", chunk)
      .order("name", { ascending: true });
    if (search) query = query.ilike("name", search.includes("-demo") ? search : `%${search}%`);
    const response = await query.limit(100);
    if (response.error) throw response.error;
    rows.push(...((response.data ?? []) as unknown as JsonRow[]));
  }
  rows.sort((left, right) => text(left.name).localeCompare(text(right.name), "en"));
  return { ids, rows };
}

export async function getClientLookup(context: AuthContext, question: string) {
  const mode = parseClientInsightMode(question);
  const search = clientSearchTerm(question);
  if (!context.supabase) {
    return result(context, "client_lookup", { mode, count: 0, clients: [] }, [], {
      total: 0,
      empty: true,
      summary: "Client data is unavailable without an authenticated database session."
    });
  }

  if (mode === "count" || mode === "search") {
    if (mode === "count") {
      const ids = await listCommerceManageableClientIds(context.supabase);
      const total = ids.length;
      return result(context, "client_lookup", { mode, count: total, clients: [] }, [], {
        total,
        summary: "Authorized active-client count loaded from the canonical commerce scope."
      });
    }
    const manageable = await manageableClientRows(context, search);
    const total = manageable.rows.length;
    const clients = manageable.rows.slice(0, 10).map(safeClient);
    if (!clients.length) {
      return result(context, "client_lookup", { mode, count: 0, clients: [] }, [], {
        total: 0,
        empty: true,
        summary: "No authorized client matched the question."
      });
    }
    return result(context, "client_lookup", { mode, count: total, clients }, clients, {
      total,
      truncated: total > clients.length,
      summary: "Authorized active clients matched the canonical commerce scope."
    });
  }

  if (!search) {
    return result(context, "client_lookup", { mode, count: 0, clients: [] }, [], {
      total: 0,
      empty: true,
      summary: "A client name is required for this authorized activity lookup."
    });
  }

  let identityQuery = context.supabase
    .from("clients")
    .select("id,name")
    .eq("status", "active")
    .is("archived_at", null)
    .order("name", { ascending: true });
  identityQuery = identityQuery.ilike("name", search.includes("-demo") ? search : `%${search}%`);
  const identityResult = await identityQuery.limit(10);
  if (identityResult.error) throw identityResult.error;
  const candidates = (identityResult.data ?? []) as unknown as JsonRow[];
  let selectedRow: JsonRow | null = null;
  for (const candidate of candidates) {
    if (await canReadCommerceClient(context, String(candidate.id))) {
      selectedRow = candidate;
      break;
    }
  }
  if (!selectedRow) {
    return result(context, "client_lookup", { mode, count: 0, clients: [] }, [], {
      total: 0,
      empty: true,
      summary: "The requested client activity is outside the current commerce scope."
    });
  }

  const clientId = String(selectedRow.id);
  const selectedClient = safeClient(selectedRow);

  if (mode === "owner") {
    const ownerResult = await context.supabase
      .from("clients")
      .select("seller:profiles!clients_assigned_salesperson_id_fkey(full_name)")
      .eq("id", clientId)
      .maybeSingle();
    if (ownerResult.error) throw ownerResult.error;
    const seller = relationOne((ownerResult.data as unknown as JsonRow | null)?.seller);
    const dataPayload = {
      mode,
      client: selectedClient,
      assignedSellerName: text(seller.full_name, 160) || null
    };
    return result(context, "client_lookup", dataPayload, [dataPayload], {
      total: 1,
      summary: "Authorized client ownership loaded from the current commerce scope."
    });
  }

  const activityResult = await context.supabase
    .from("commerce_quotes")
    .select("quote_number,status,created_at", { count: "exact" })
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (activityResult.error) throw activityResult.error;
  const quotes = ((activityResult.data ?? []) as unknown as JsonRow[]).map((row) => ({
    number: text(row.quote_number, 100),
    status: text(row.status, 30),
    createdAt: text(row.created_at, 40)
  }));
  const activityCount = activityResult.count ?? quotes.length;
  return result(context, "client_lookup", {
    mode,
    client: selectedClient,
    activityCount,
    quotes
  }, quotes, {
    total: activityCount,
    truncated: activityCount > quotes.length,
    summary: "Authorized quote activity loaded for the requested client."
  });
}
