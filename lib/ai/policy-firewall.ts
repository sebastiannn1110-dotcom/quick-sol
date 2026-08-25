import type { AssistantLanguage } from "@/lib/ai/language-detection";
import type { AssistantAnswerMode } from "@/lib/ai/response-plan";

export type AssistantPolicyIntent =
  | "policy_safety"
  | "system_prompt_extraction"
  | "internal_instructions_request"
  | "sql_execution_request"
  | "tool_override_request"
  | "role_escalation_request"
  | "cross_user_data_request"
  | "conversation_access_request"
  | "permission_bypass_request";

export interface AssistantPolicyMatch {
  intent: AssistantPolicyIntent;
  tool: "policySafetyBoundary";
  answerMode: Extract<AssistantAnswerMode, "deny">;
  confidence: 1;
  language: AssistantLanguage;
}

function normalized(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const POLICY_PATTERNS: Array<{
  intent: AssistantPolicyIntent;
  pattern: RegExp;
}> = [
  {
    intent: "system_prompt_extraction",
    pattern:
      /\b(system prompt|prompt del sistema|prompt interno|mensaje del sistema|提示词|系统提示)\b/i
  },
  {
    intent: "internal_instructions_request",
    pattern:
      /\b(instrucciones internas|instrucciones ocultas|hidden instructions|internal instructions|开发者指令|内部指令)\b/i
  },
  {
    intent: "sql_execution_request",
    pattern:
      /\b(ejecuta|ejecutar|execute|run)\b.{0,40}\b(sql|select|insert|update|delete|drop|alter|truncate)\b|\bselect\s+.+\s+from\b|\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|alter\s+table|truncate\s+table)\b|执行\s*(sql|select)/i
  },
  {
    intent: "role_escalation_request",
    pattern:
      /\b(cambia|cambiar|eleva|elevar|asigna|asignar|change|switch|elevate|promote)\b.{0,40}\b(mi\s+rol|role|administrador|administrator|admin)\b|把我.{0,20}(管理员|角色)|提升.{0,20}(权限|管理员)/i
  },
  {
    intent: "conversation_access_request",
    pattern:
      /\b(conversaciones?|chats?|mensajes?)\b.{0,50}\b(otros?|ajenas?|vendedores?|usuarios?|empleados?)\b|\b(other users?|other sellers?|someone else'?s)\b.{0,30}\b(conversations?|chats?|messages?)\b|其他用户.{0,20}(对话|消息)/i
  },
  {
    intent: "cross_user_data_request",
    pattern:
      /\b(datos?|informacion|registros?|archivos?)\b.{0,50}\b(otros?|ajenos?|vendedores?|usuarios?|empleados?)\b|\b(other users?|other sellers?|someone else'?s)\b.{0,30}\b(data|records?|files?)\b|其他用户.{0,20}(数据|记录|文件)/i
  },
  {
    intent: "permission_bypass_request",
    pattern:
      /\b(salta|omite|evade|desactiva|bypass|disable|ignore)\b.{0,35}\b(permisos?|restricciones?|seguridad|permissions?|authorization|auth)\b|绕过.{0,20}(权限|安全)/i
  },
  {
    intent: "tool_override_request",
    pattern:
      /\b(usa|utiliza|cambia a|use|switch to)\b.{0,30}\b(otra herramienta|otro tool|different tool|another tool)\b|使用.{0,20}(其他|另一个)工具/i
  },
  {
    intent: "policy_safety",
    pattern:
      /\b(ignora|ignore)\b.{0,25}\b(reglas?|rules?|instrucciones?)\b|\b(raw_data|normalized_data|raw_value)\b|忽略.{0,20}(规则|指令)/i
  }
];

export function detectAssistantPolicyIntent(
  question: string,
  language: AssistantLanguage
): AssistantPolicyMatch | null {
  const value = normalized(question);
  const match = POLICY_PATTERNS.find((entry) => entry.pattern.test(value));
  if (!match) return null;
  return {
    intent: match.intent,
    tool: "policySafetyBoundary",
    answerMode: "deny",
    confidence: 1,
    language
  };
}
