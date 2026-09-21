const sensitiveField = /authorization|api[-_]?key|secret|password|credential|database[-_]?url|redis[-_]?url|idempotency[-_]?key|body|payload/i;
const redacted = "[REDACTED]";

function redact(value: unknown, depth: number): unknown {
  if (depth > 5 || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sensitiveField.test(key)
      ? redacted
      : redact(item, depth + 1);
  }
  return result;
}

export function redactSensitiveLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return redact(fields, 0) as Record<string, unknown>;
}
