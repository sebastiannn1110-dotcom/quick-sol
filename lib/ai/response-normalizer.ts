function collapseWhitespace(value: string) {
  return value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const TECHNICAL_LEAK_RE =
  /\b(OPEN_IA|OPENAI_MODEL|OPENAI_API_KEY|Render|Supabase|Postgres|statement timeout|service role|stack trace|DATABASE_TIMEOUT|57014|PGRST|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\b/i;

export const SAFE_ASSISTANT_FALLBACK =
  "No pude obtener todos los detalles en este momento, pero puedo mostrarte el resumen disponible.";

export const TIMEOUT_ASSISTANT_FALLBACK =
  "La consulta tardó demasiado. Te muestro el resumen disponible y puedes intentar una pregunta más específica.";

export function hasTechnicalLeak(value: string) {
  return TECHNICAL_LEAK_RE.test(value);
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "$1");
}

function removeTables(value: string) {
  return value
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const pipeCount = (trimmed.match(/\|/g) ?? []).length;
      if (pipeCount >= 2) return false;
      return !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
    })
    .join("\n");
}

function removeLongUrls(value: string) {
  return value.replace(/https?:\/\/\S{18,}/g, " enlace disponible en pantalla ");
}

function removeInternalIds(value: string) {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "")
    .replace(/\b[a-z0-9_-]{24,}\b/gi, "");
}

function listMarkersToSpeech(value: string) {
  return value
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\n+/g, ". ");
}

function sentenceLimit(value: string, maxSentences: number) {
  const sentences = value.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [value];
  const limited = sentences.slice(0, maxSentences).join(" ").trim();
  return sentences.length > maxSentences ? `${limited} Puedo darte mas detalle si lo necesitas.` : limited;
}

export function normalizeTextResponse(input: string, options?: { fallback?: string }) {
  const cleaned = collapseWhitespace(
    input
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
  );
  return hasTechnicalLeak(cleaned) ? options?.fallback ?? SAFE_ASSISTANT_FALLBACK : cleaned;
}

export function normalizeSpeechResponse(input: string, options?: { maxCharacters?: number; maxSentences?: number }) {
  const maxCharacters = options?.maxCharacters ?? 900;
  const maxSentences = options?.maxSentences ?? 5;
  const cleaned = collapseWhitespace(
    listMarkersToSpeech(
      removeInternalIds(
        removeLongUrls(
          removeTables(
            stripMarkdown(input)
          )
        )
      )
        .replace(/[|*_#>{}[\]]/g, " ")
        .replace(/\s*[:;]\s*/g, ". ")
        .replace(/\s+([,.!?。！？])/g, "$1")
    )
  );
  const limited = sentenceLimit(cleaned.length > maxCharacters ? `${cleaned.slice(0, maxCharacters)}.` : cleaned, maxSentences);
  return collapseWhitespace(limited);
}
