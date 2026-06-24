const SECRET_KEY_RE =
  /(password|pass|token|access_token|refresh_token|authorization|cookie|service_role|secret|api[_-]?key|jwt)/i;

const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 4;
const MAX_ARRAY_LENGTH = 20;
const MAX_OBJECT_KEYS = 60;

export function truncateForLog(value: unknown, maxLength = MAX_STRING_LENGTH) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text;
}

export function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  return `${name.slice(0, 2)}***@${domain}`;
}

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<max-depth>";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateForLog(value.message),
      stack:
        process.env.NODE_ENV === "development" && value.stack
          ? truncateForLog(value.stack, 2000)
          : undefined
    };
  }
  if (typeof value === "string") {
    const truncated = truncateForLog(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(truncated) ? maskEmail(truncated) : truncated;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeForLog(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    return entries.reduce<Record<string, unknown>>((acc, [key, item]) => {
      if (SECRET_KEY_RE.test(key)) {
        acc[key] = "<redacted>";
      } else if (key === "raw_data" || key === "rawData") {
        acc[key] = "<raw-data-redacted>";
      } else {
        acc[key] = sanitizeForLog(item, depth + 1);
      }
      return acc;
    }, {});
  }

  return String(value);
}

export function sanitizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncateForLog(error.message),
      stack:
        process.env.NODE_ENV === "development" && error.stack
          ? truncateForLog(error.stack, 2000)
          : undefined
    };
  }

  const sanitized = sanitizeForLog(error);
  return {
    message: typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized)
  };
}
