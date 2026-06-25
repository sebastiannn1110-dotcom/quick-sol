import OpenAI from "openai";
import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { checkRateLimit, rateLimitResponse } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getOpenAIKey() {
  return process.env.OPEN_IA || process.env.OPENAI_API_KEY || "";
}

function compact(value: unknown) {
  return JSON.stringify(value, null, 2).slice(0, 12000);
}

function cleanSearchText(message: string) {
  return message
    .replace(/[^\p{L}\p{N}\s._@-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim();
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

  let uploads: unknown[] = [];
  let records: unknown[] = [];

  if (supabase) {
    let uploadsQuery = supabase
      .from("upload_batches")
      .select("id, uploaded_by, original_file_name, detected_category, status, total_rows, valid_rows, invalid_rows, created_at, profiles(full_name,email,department,role)")
      .order("created_at", { ascending: false })
      .limit(8);
    if (!isAdmin) uploadsQuery = uploadsQuery.eq("uploaded_by", context.profile.id);
    const uploadsResult = await uploadsQuery;
    uploads = uploadsResult.data ?? [];

    let recordsQuery = supabase
      .from("business_records")
      .select("id, uploaded_by, category, customer, supplier, supplier_name, mpn, description, qty, price, total_price, gp_rate, searchable_text, created_at, upload_batches(original_file_name), profiles(full_name,email,department,role)")
      .order("created_at", { ascending: false })
      .limit(12);
    if (!isAdmin) recordsQuery = recordsQuery.eq("uploaded_by", context.profile.id);
    if (searchText.length >= 3) recordsQuery = recordsQuery.ilike("searchable_text", `%${searchText}%`);
    const recordsResult = await recordsQuery;
    records = recordsResult.data ?? [];
  }

  const client = new OpenAI({ apiKey });
  const roleScope = isAdmin
    ? "El usuario es admin: puede recibir resumenes globales de empleados, uploads y registros."
    : "El usuario es empleado: solo debes hablar de sus propios datos y de como usar el programa.";

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      instructions: [
        "Eres el asistente interno de Quiksol Excel Intelligence System.",
        "Responde siempre en espanol claro y operativo.",
        "Ayuda a encontrar datos cargados, explicar el uso del sistema, interpretar registros y orientar al usuario.",
        "No inventes datos. Si el contexto no contiene la informacion, dilo y sugiere donde buscar o que subir.",
        "No reveles secretos, tokens, service_role keys ni datos fuera del alcance del rol.",
        roleScope
      ].join(" "),
      input: [
        `Perfil: ${context.profile.full_name} (${context.profile.role})`,
        `Pregunta: ${message}`,
        `Ultimos uploads disponibles: ${compact(uploads)}`,
        `Registros relacionados: ${compact(records)}`
      ].join("\n\n"),
      max_output_tokens: 700
    });

    return NextResponse.json({
      answer: response.output_text?.trim() || "No encontre una respuesta util con el contexto disponible."
    });
  } catch {
    return NextResponse.json(
      { error: "El asistente no pudo generar respuesta. Revisa OPEN_IA y OPENAI_MODEL en Render." },
      { status: 502 }
    );
  }
}
