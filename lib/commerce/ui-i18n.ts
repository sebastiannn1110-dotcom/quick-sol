import type { Language } from "@/lib/i18n";

const copy: Record<Language, { demoNotice: string }> = {
  en: { demoNotice: "Fictitious demo account — no commercial affiliation implied." },
  es: { demoNotice: "Cuenta ficticia de demostración — no implica relación comercial." },
  zh: { demoNotice: "虚构演示账户 — 不代表任何商业关联。" }
};

export function commerceCopy(language: Language) {
  return copy[language];
}
