import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/context";
import { rateLimitResponse } from "@/lib/security/rateLimit";
import { checkPersistentRateLimit } from "@/lib/security/persistent-rate-limit";
import { answerAssistantQuestion, AssistantConfigError, type AssistantLanguage } from "@/lib/ai/assistantCore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeRequestLanguage(language: unknown): AssistantLanguage {
  if (language === "zh") return "zh";
  if (language === "en") return "en";
  return "es";
}

export async function POST(request: Request) {
  const context = await getAuthContext(request);
  if (context instanceof NextResponse) return context;

  const body = (await request.json().catch(() => null)) as { message?: string; language?: string } | null;
  const message = body?.message?.trim();
  const language = normalizeRequestLanguage(body?.language);
  if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

  const rate = await checkPersistentRateLimit({
    action: "assistant",
    identifier: context.profile.id,
    limit: 30,
    windowSeconds: 15 * 60,
    blockSeconds: 5 * 60
  });
  if (!rate.allowed) return rateLimitResponse(rate.resetAt);

  try {
    const result = await answerAssistantQuestion({ context, message, language });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AssistantConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      { error: "El asistente no pudo generar respuesta. Revisa OPEN_IA y OPENAI_MODEL en Render." },
      { status: 502 }
    );
  }
}
