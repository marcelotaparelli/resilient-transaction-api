import { describe, expect, test } from "bun:test";
import { redactSensitiveLogFields } from "../../src/http/security/log-redaction";

describe("redactSensitiveLogFields", () => {
  test("redacts credentials, URLs, idempotency keys and payloads recursively", () => {
    const sensitiveValues = [
      "Bearer top-secret-key",
      "top-secret-key",
      "postgres://user:password@database/internal",
      "redis://user:password@redis/internal",
      "idempotency-secret-value",
      "full-sensitive-transaction-body",
    ];
    const redacted = redactSensitiveLogFields({
      event: "request_failed",
      headers: { Authorization: sensitiveValues[0] },
      apiKey: sensitiveValues[1],
      databaseUrl: sensitiveValues[2],
      redis_url: sensitiveValues[3],
      idempotencyKey: sensitiveValues[4],
      payload: sensitiveValues[5],
      safe: { method: "POST", status: 500 },
    });
    const serialized = JSON.stringify(redacted);

    for (const value of sensitiveValues) expect(serialized).not.toContain(value);
    expect(redacted).toMatchObject({
      event: "request_failed",
      safe: { method: "POST", status: 500 },
      apiKey: "[REDACTED]",
    });
  });
});
