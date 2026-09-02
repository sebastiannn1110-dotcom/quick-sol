export type ExplicitBusinessIntent =
  | "employee_quote_metrics"
  | "client_lookup";

export function normalizeBusinessQuestion(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._@/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(value: string, phrases: readonly string[]) {
  return phrases.some((phrase) => value.includes(phrase));
}

const RFQ_TERMS = [
  "rfq",
  "rfqs",
  "request for quote",
  "requests for quote",
  "solicitud de cotizacion",
  "solicitudes de cotizacion",
  "询价",
  "报价请求"
] as const;

const EMPLOYEE_TERMS = [
  "vendedor",
  "vendedores",
  "empleado de ventas",
  "empleados de ventas",
  "equipo de ventas",
  "equipo comercial",
  "ejecutivo comercial",
  "comercial",
  "seller",
  "sellers",
  "salesperson",
  "salespeople",
  "sales rep",
  "sales representative",
  "sales team",
  "account executive",
  "employee performance",
  "销售人员",
  "销售员",
  "销售代表",
  "业务员",
  "销售团队"
] as const;

const PERFORMANCE_TERMS = [
  "mejor",
  "mejores",
  "top",
  "ranking",
  "rank",
  "metricas",
  "metrica",
  "desempeno",
  "rendimiento",
  "conversion",
  "cotizaciones aceptadas",
  "cotizaciones enviadas",
  "quotes accepted",
  "accepted quotes",
  "quotes sent",
  "sent quotes",
  "accepted quote value",
  "quotes en draft",
  "draft quotes",
  "clientes ha atendido",
  "clientes atendidos",
  "customers served",
  "por debajo del promedio",
  "below average",
  "necesita mejorar",
  "needs improvement",
  "best",
  "highest",
  "performance",
  "performing",
  "performs better",
  "funcionando",
  "funciona el equipo",
  "metrics",
  "表现最好",
  "最佳",
  "最好",
  "绩效",
  "指标",
  "转化率",
  "转换率",
  "已接受报价",
  "已发送报价",
  "排名"
] as const;

const STRONG_EMPLOYEE_METRICS = [
  "conversion",
  "cotizaciones aceptadas",
  "cotizaciones enviadas",
  "accepted quotes",
  "quotes accepted",
  "sent quotes",
  "quotes sent",
  "accepted quote value",
  "clientes ha atendido",
  "clientes atendidos",
  "customers served",
  "mejores metricas",
  "best metrics",
  "por debajo del promedio",
  "below average",
  "necesita mejorar",
  "needs improvement",
  "转化率",
  "转换率",
  "已接受报价",
  "已发送报价",
  "绩效",
  "表现最好"
] as const;

const CLIENT_TERMS = [
  "cliente",
  "clientes",
  "client",
  "clients",
  "customer",
  "customers",
  "account client",
  "cuenta demo",
  "客户"
] as const;

const CLIENT_ACTIONS = [
  "cuantos",
  "cuantas",
  "how many",
  "busca",
  "buscar",
  "search",
  "find",
  "quien atiende",
  "quien gestiona",
  "who handles",
  "who manages",
  "cotizaciones tiene",
  "quotes does",
  "rfqs tiene",
  "rfqs does",
  "多少",
  "查找",
  "谁负责"
] as const;

function looksLikeEmployeeComparison(question: string) {
  const value = normalizeBusinessQuestion(question);
  if (/\b(?:stock|inventario|mpn|opportunit(?:y|ies)|oportunidades?)\b/u.test(value)) {
    return false;
  }
  return (
    /\b(?:compara|comparar|compare)\s+(?:a\s+)?[\p{L}][\p{L}'-]{1,}(?:\s+[\p{L}][\p{L}'-]{1,})?\s+(?:con|contra|vs\.?|with|and)\s+[\p{L}][\p{L}'-]{1,}(?:\s+[\p{L}][\p{L}'-]{1,})?/iu.test(question) ||
    /\bwho\b.{0,20}\b(?:performs?|is)\b.{0,12}\bbetter\b.{0,80}\b(?:or|than|vs\.?)\b/iu.test(question) ||
    /\bquien\b.{0,20}\b(?:rinde|tiene)\b.{0,12}\bmejor\b.{0,80}\b(?:o|que|vs\.?)\b/iu.test(question) ||
    /(?:比较|对比).{1,80}(?:和|与|跟|vs).{1,80}/u.test(question)
  );
}

/**
 * High-confidence business routing for concepts that are unambiguous without
 * asking a model to choose a database tool. This complements the fuzzy alias
 * catalog; it intentionally does not handle a bare "who is the best?".
 */
export function detectExplicitBusinessIntent(question: string): ExplicitBusinessIntent | null {
  const value = normalizeBusinessQuestion(question);
  if (!value) return null;

  const demoAccount = /(?:^|\s)[\p{L}\p{N}][\p{L}\p{N}-]*-demo(?=$|\s|[./])/u.test(value);
  const hasRfq = includesAny(value, RFQ_TERMS);
  const hasQuote = /\b(?:quote|quotes|cotizacion|cotizaciones)\b/u.test(value) || value.includes("报价");

  // A named demo account remains a client query even when the requested
  // activity happens to be an RFQ or quote.
  if (demoAccount && (hasRfq || hasQuote || includesAny(value, CLIENT_ACTIONS))) {
    return "client_lookup";
  }

  if (hasRfq) return null;

  const hasEmployee = includesAny(value, EMPLOYEE_TERMS);
  const hasPerformance = includesAny(value, PERFORMANCE_TERMS);
  const hasStrongMetric = includesAny(value, STRONG_EMPLOYEE_METRICS);
  const comparison = looksLikeEmployeeComparison(question);
  if (
    comparison ||
    (hasEmployee && hasPerformance) ||
    hasStrongMetric ||
    /\b(?:active sellers|vendedores activos)\b/u.test(value)
  ) {
    return "employee_quote_metrics";
  }

  const hasClient = includesAny(value, CLIENT_TERMS);
  if (demoAccount || (hasClient && includesAny(value, CLIENT_ACTIONS))) {
    return "client_lookup";
  }

  return null;
}

export function isEmployeePerformanceFollowUp(
  question: string,
  history: readonly { role: string; content: string }[]
) {
  const value = normalizeBusinessQuestion(question);
  const ordinalFollowUp = /^(?:y|and|then|那么|那)?\s*(?:el|la|los|las|the)?\s*(?:segund[oa]|tercer[oa]|siguientes?|second|third|next|第二|第三|接下来)/u.test(
    value
  );
  if (!ordinalFollowUp) return false;

  const previousUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");
  return Boolean(
    previousUserMessage &&
    detectExplicitBusinessIntent(previousUserMessage.content) === "employee_quote_metrics"
  );
}
