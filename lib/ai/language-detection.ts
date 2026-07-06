export type AssistantLanguage = "es" | "en" | "zh";

const SPANISH_HINTS = /\b(el|la|los|las|que|como|ultimo|ultima|subido|archivo|proveedor|cliente|errores|filas|muestrame|busca|precio|costos?|comision|registros?)\b/;
const ENGLISH_HINTS = /\b(the|last|file|upload|show|find|supplier|customer|errors|rows|how|what|price|cost|commission|records?)\b/;

export function normalizeAssistantLanguage(language: unknown, fallback: AssistantLanguage = "es"): AssistantLanguage {
  if (typeof language !== "string") return fallback;
  const value = language.trim().toLowerCase();
  if (value === "zh" || value === "zh-cn" || value === "chinese" || value === "simplified chinese" || value === "中文") return "zh";
  if (value === "en" || value === "en-us" || value === "en-gb" || value === "english") return "en";
  if (value === "es" || value === "es-es" || value === "es-co" || value === "spanish" || value === "espanol" || value === "español") return "es";
  return fallback;
}

export function detectAssistantLanguage(text: string, suggestedLanguage?: unknown): AssistantLanguage {
  const suggested = normalizeAssistantLanguage(suggestedLanguage, "es");
  if (typeof suggestedLanguage === "string" && suggestedLanguage.trim()) return suggested;
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";

  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const spanishScore = (normalized.match(SPANISH_HINTS) ?? []).length;
  const englishScore = (normalized.match(ENGLISH_HINTS) ?? []).length;
  if (englishScore > spanishScore) return "en";
  return "es";
}

export function languageName(language: AssistantLanguage) {
  if (language === "zh") return "Simplified Chinese";
  if (language === "en") return "English";
  return "Spanish";
}
