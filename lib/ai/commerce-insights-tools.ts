import type { AuthContext } from "@/lib/auth/context";
import { getAiPermissionScope } from "@/lib/ai/ai-permissions";
import type { AiToolResult } from "@/lib/ai/database-tools";
import { normalizeBusinessQuestion } from "@/lib/ai/business-intent";
import { listCommerceManageableClientIds } from "@/lib/commerce/service";
import { analyticsVisibleEmployeeIds } from "@/lib/organization/scope";
import { loadOrganizationDirectory } from "@/lib/organization/service";

type JsonRow = Record<string, unknown>;
type InsightToolName = "rfq_summary" | "client_lookup";

export type RfqInsightMode = "new_count" | "unassigned" | "latest" | "employee" | "summary";
export type ClientInsightMode = "count" | "search" | "owner" | "rfqs" | "quotes";

const RFQ_SAFE_SELECT = [
  "external_rfq_id",
  "status",
  "source",
  "created_at",
  "client:clients!commerce_rfqs_client_id_fkey(name)",
  "seller:profiles!commerce_rfqs_assigned_salesperson_id_fkey(full_name)",
  "items:commerce_rfq_items(id)"
].join(",");

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

export function parseRfqInsightMode(question: string): RfqInsightMode {
  const value = normalizeBusinessQuestion(question);
  if (/\b(?:sin asignar|unassigned|no asignados?)\b/u.test(value) || value.includes("未分配")) {
    return "unassigned";
  }
  if (/\b(?:mas reciente|mas recientemente|ultimo|ultima|latest|most recent|newest)\b/u.test(value) || value.includes("最近")) {
    return "latest";
  }
  if (/\b(?:nuevos?|new)\b/u.test(value) || value.includes("新询价") || value.includes("新的rfq")) {
    return "new_count";
  }
  if (/\b(?:tiene|asignados? a|assigned to|for)\b/u.test(value) || value.includes("负责")) {
    return "employee";
  }
  return "summary";
}

function employeeMatches(question: string, name: string) {
  const value = normalizeBusinessQuestion(question);
  const normalizedName = normalizeBusinessQuestion(name);
  if (!normalizedName) return false;
  if (value.includes(normalizedName)) return true;
  const tokens = normalizedName.split(" ").filter((token) => token.length >= 3);
  return tokens.some((token) => new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`, "u").test(value));
}

async function resolveVisibleEmployee(context: AuthContext, question: string) {
  const directory = await loadOrganizationDirectory(context);
  const visibleIds = analyticsVisibleEmployeeIds(directory.actor, directory.members);
  const candidates = directory.members
    .filter((member) => visibleIds.has(member.profileId) && employeeMatches(question, member.name))
    .map((member) => ({ id: member.profileId, name: text(member.name, 160) }));
  const exact = candidates.filter((candidate) =>
    normalizeBusinessQuestion(question).includes(normalizeBusinessQuestion(candidate.name))
  );
  return exact.length ? exact : candidates;
}

function safeRfq(row: JsonRow) {
  const client = relationOne(row.client);
  const seller = relationOne(row.seller);
  return {
    externalRfqId: text(row.external_rfq_id, 160),
    status: text(row.status, 30),
    source: text(row.source, 40),
    createdAt: text(row.created_at, 40),
    companyOrName: text(client.name, 200),
    assignedSellerName: text(seller.full_name, 160) || null,
    itemCount: Array.isArray(row.items) ? row.items.length : 0
  };
}

export async function getRfqSummary(context: AuthContext, question: string) {
  const mode = parseRfqInsightMode(question);
  if (!context.supabase) {
    return result(context, "rfq_summary", { mode, count: 0, rfqs: [] }, [], {
      total: 0,
      empty: true,
      summary: "RFQ data is unavailable without an authenticated database session."
    });
  }

  let sellerId: string | null = null;
  let employeeName: string | null = null;
  if (mode === "employee") {
    const candidates = await resolveVisibleEmployee(context, question);
    if (candidates.length > 1) {
      const names = candidates.map((candidate) => candidate.name).sort((a, b) => a.localeCompare(b, "en"));
      return result(context, "rfq_summary", {
        mode,
        count: 0,
        rfqs: [],
        clarification: { reason: "duplicate_employee_name", candidates: names }
      }, [], {
        total: 0,
        summary: "More than one visible employee matches the requested name."
      });
    }
    if (candidates.length === 0) {
      return result(context, "rfq_summary", { mode, count: 0, rfqs: [] }, [], {
        total: 0,
        empty: true,
        summary: "No authorized employee matched the RFQ question."
      });
    }
    sellerId = candidates[0].id;
    employeeName = candidates[0].name;
  }

  let query = context.supabase
    .from("commerce_rfqs")
    .select(mode === "new_count" ? "id" : RFQ_SAFE_SELECT, { count: "exact" });

  if (mode === "new_count") {
    query = query
      .in("status", ["unassigned", "assigned"])
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  } else if (mode === "unassigned") {
    query = query.eq("status", "unassigned");
  } else if (sellerId) {
    query = query.eq("assigned_salesperson_id", sellerId);
  }

  const limit = mode === "latest" || mode === "new_count" ? 1 : 10;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rfqs = ((data ?? []) as unknown as JsonRow[]).map(safeRfq);
  const total = count ?? rfqs.length;
  const responseData = {
    mode,
    definition: mode === "new_count"
      ? "New means an unassigned or assigned RFQ created during the last 24 hours."
      : null,
    employeeName,
    count: total,
    rfqs: mode === "new_count" ? [] : rfqs
  };
  return result(context, "rfq_summary", responseData, mode === "new_count" ? [] : rfqs, {
    total,
    truncated: mode !== "new_count" && total > rfqs.length,
    summary: "Authorized RFQ summary loaded through the current user's RLS scope."
  });
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
  if (/\brfqs?\b/u.test(value) || value.includes("询价")) return "rfqs";
  if (/\b(?:quote|quotes|cotizacion|cotizaciones)\b/u.test(value) || value.includes("报价")) return "quotes";
  if (/\b(?:quien atiende|quien gestiona|who handles|who manages|assigned seller|vendedor asignado)\b/u.test(value) || value.includes("谁负责")) {
    return "owner";
  }
  if (/\b(?:cuantos clientes|cuantas cuentas|how many clients|how many customers)\b/u.test(value) || value.includes("多少客户")) {
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

  if (mode === "rfqs") {
    const activityResult = await context.supabase
      .from("commerce_rfqs")
      .select("external_rfq_id,status,created_at", { count: "exact" })
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (activityResult.error) throw activityResult.error;
    const rfqs = ((activityResult.data ?? []) as unknown as JsonRow[]).map((row) => ({
      externalRfqId: text(row.external_rfq_id, 160),
      status: text(row.status, 30),
      createdAt: text(row.created_at, 40)
    }));
    const activityCount = activityResult.count ?? rfqs.length;
    return result(context, "client_lookup", {
      mode,
      client: selectedClient,
      activityCount,
      rfqs
    }, rfqs, {
      total: activityCount,
      truncated: activityCount > rfqs.length,
      summary: "Authorized RFQ activity loaded for the requested client."
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
