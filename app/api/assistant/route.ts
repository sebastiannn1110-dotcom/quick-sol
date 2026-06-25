import OpenAI from "openai";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AssistantIntent =
  | "search_mpn"
  | "search_supplier"
  | "search_customer"
  | "search_upload"
  | "search_employee_uploads"
  | "explain_metric"
  | "explain_import_errors"
  | "summarize_dashboard"
  | "find_record_by_id"
  | "admin_global_search"
  | "help_usage";

function getOpenAIKey() {
  return process.env.OPEN_IA || process.env.OPENAI_API_KEY || "";
}

function compact(value: unknown, max = 9000) {
  return JSON.stringify(value, null, 2).slice(0, max);
}

function cleanSearchText(message: string) {
  return message
    .replace(/[^\p{L}\p{N}\s._@-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function detectIntent(message: string, isAdmin: boolean): AssistantIntent {
  const text = message.toLowerCase();
  if (/mpn|part number|pn|p\/n/i.test(text)) return "search_mpn";
  if (/supplier|proveedor/i.test(text)) return "search_supplier";
  if (/customer|cliente/i.test(text)) return "search_customer";
  if (/error|errores|import/i.test(text)) return "explain_import_errors";
  if (/upload|subi[oó]|carga|excel/i.test(text) && /employee|empleado|luis|quiksol/i.test(text)) return "search_employee_uploads";
  if (/upload|carga|excel/i.test(text)) return "search_upload";
  if (/dashboard|resumen|summary|metric|m[eé]trica|gp|commission|comisi[oó]n/i.test(text)) return "summarize_dashboard";
  if (/record|registro|id/i.test(text)) return "find_record_by_id";
  if (/como|how|help|ayuda|usar/i.test(text)) return "help_usage";
  return isAdmin ? "admin_global_search" : "help_usage";
}

function likelyName(message: string) {
  const match = message.match(/\b(?:de|from|employee|empleado|subi[oó])\s+([A-ZÁÉÍÓÚÑ][\p{L}\s]{1,40})/u);
  return match?.[1]?.trim() ?? "";
}

function groupSum<T extends Record<string, unknown>>(rows: T[], labelKeys: string[], valueKey: string) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = labelKeys.map((key) => row[key]).find((value) => typeof value === "string" && value.trim()) as string | undefined;
    if (!label) continue;
    const value = Number(row[valueKey] ?? 0);
    totals.set(label, (totals.get(label) ?? 0) + (Number.isFinite(value) ? value : 0));
  }
  return Array.from(totals.entries())
    .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const body = (await request.json().catch(() => null)) as { message?: string; language?: string } | null;
  const message = body?.message?.trim();
  const language = body?.language === "zh" ? "Chinese" : body?.language === "en" ? "English" : "Spanish";
  if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

  const rate = checkRateLimit({
    key: `assistant:${context.profile.id}`,
    limit: 30,
    windowMs: 15 * 60 * 1000
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "El asistente no esta configurado. Agrega OPEN_IA en Render." },
      { status: 503 }
    );
  }

  const supabase = context.supabase;
  const isAdmin = context.profile.role === "admin";
  const searchText = cleanSearchText(message);
  const intent = detectIntent(message, isAdmin);

  let uploads: unknown[] = [];
  let records: unknown[] = [];
  let errors: unknown[] = [];
  let employees: unknown[] = [];
  let aggregates: unknown[] = [];

  if (supabase) {
    const employeeName = isAdmin ? likelyName(message) : "";
    if (isAdmin && employeeName) {
      const employeeResult = await supabase
        .from("profiles")
        .select("id, full_name, email, department, region, role")
        .ilike("full_name", `%${employeeName}%`)
        .limit(5);
      employees = employeeResult.data ?? [];
    }
    const employeeIds = employees.map((employee) => (employee as { id: string }).id);

    let uploadsQuery = supabase
      .from("upload_batches")
      .select("id, uploaded_by, original_file_name, detected_category, status, total_rows, valid_rows, invalid_rows, error_count, data_quality_score, created_at, profiles(full_name,email,department,role)")
      .order("created_at", { ascending: false })
      .limit(10);
    if (!isAdmin) uploadsQuery = uploadsQuery.eq("uploaded_by", context.profile.id);
    if (isAdmin && employeeIds.length === 1) uploadsQuery = uploadsQuery.eq("uploaded_by", employeeIds[0]);
    const uploadsResult = await uploadsQuery;
    uploads = uploadsResult.data ?? [];

    let recordsQuery = supabase
      .from("business_records")
      .select("id, uploaded_by, upload_batch_id, category, customer, client, supplier, supplier_name, mpn, mpn_quoted, po, description, qty, price, total_price, gp_rate, gp, commission, searchable_text, created_at, upload_batches(original_file_name), profiles(full_name,email,department,role)")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!isAdmin) recordsQuery = recordsQuery.eq("uploaded_by", context.profile.id);
    if (isAdmin && employeeIds.length === 1) recordsQuery = recordsQuery.eq("uploaded_by", employeeIds[0]);
    if (searchText.length >= 3 && !["summarize_dashboard", "help_usage"].includes(intent)) {
      const pattern = `%${searchText}%`;
      recordsQuery = recordsQuery.or(`searchable_text.ilike.${pattern},mpn.ilike.${pattern},mpn_quoted.ilike.${pattern},supplier.ilike.${pattern},supplier_name.ilike.${pattern},customer.ilike.${pattern},po.ilike.${pattern}`);
    }
    const recordsResult = await recordsQuery;
    records = recordsResult.data ?? [];

    if (intent === "explain_import_errors") {
      const latestUploadId = (uploads[0] as { id?: string } | undefined)?.id;
      let errorsQuery = supabase
        .from("import_errors")
        .select("id, trace_id, upload_batch_id, row_index, column_name, error_type, message, raw_value, severity, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      if (latestUploadId) errorsQuery = errorsQuery.eq("upload_batch_id", latestUploadId);
      const errorsResult = await errorsQuery;
      errors = errorsResult.data ?? [];
    }

    if (isAdmin && /supplier|proveedor|gp|profit|ganancia/i.test(message)) {
      const gpResult = await supabase
        .from("business_records")
        .select("supplier, supplier_name, gp")
        .is("archived_at", null)
        .limit(5000);
      aggregates = groupSum((gpResult.data ?? []) as Array<Record<string, unknown>>, ["supplier_name", "supplier"], "gp");
    }
  }

  const client = new OpenAI({ apiKey });
  const roleScope = isAdmin
    ? "The user is admin: they can receive global summaries about employees, uploads and records."
    : "The user is employee: only discuss their own records, uploads and import errors.";

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      instructions: [
        "You are the internal assistant for Quiksol Excel Intelligence System.",
        `Respond in ${language}.`,
        "Use only the provided Supabase context. Do not invent records.",
        "Never reveal secrets, tokens, cookies, service role keys or OpenAI keys.",
        "If context is not enough, say what filter, upload or search the user should try next.",
        roleScope
      ].join(" "),
      input: [
        `Intent: ${intent}`,
        `Profile: ${context.profile.full_name} (${context.profile.role})`,
        `Question: ${message}`,
        `Matching employees: ${compact(employees, 2500)}`,
        `Recent or filtered uploads: ${compact(uploads, 5000)}`,
        `Relevant records, max 20: ${compact(records, 7000)}`,
        `Relevant import errors, max 10: ${compact(errors, 3500)}`,
        `Server-side aggregates: ${compact(aggregates, 2500)}`
      ].join("\n\n"),
      max_output_tokens: 800
    });

    return NextResponse.json({
      intent,
      answer: response.output_text?.trim() || "No encontre una respuesta util con el contexto disponible."
    });
  } catch {
    return NextResponse.json(
      { error: "El asistente no pudo generar respuesta. Revisa OPEN_IA y OPENAI_MODEL en Render." },
      { status: 502 }
    );
  }
}
