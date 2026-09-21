import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const serviceCredentials = JSON.stringify([
  { serviceId: "test-service", apiKeySha256: "a".repeat(64) },
]);

describe("loadConfig", () => {
  test("centralizes validated provider resilience defaults", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      REDIS_URL: "redis://localhost:6379",
      SERVICE_CREDENTIALS: serviceCredentials,
    });

    expect(config.retry).toEqual({
      maxAttempts: 3,
      attemptTimeoutMs: 3_000,
      baseDelayMs: 500,
      maxDelayMs: 2_000,
      jitterRatio: 0.2,
    });
    expect(config.breaker).toEqual({
      failureThreshold: 3,
      openDurationMs: 10_000,
    });
    expect(config.processingStaleTimeoutMs).toBe(30_000);
    expect(config.redisCommandTimeoutMs).toBe(250);
    expect(config.transactionCacheTtlSeconds).toBe(3_600);
    expect(config.rateLimitMaxRequests).toBe(5);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.httpMaxBodyBytes).toBe(16_384);
    expect(config.serviceCredentials).toEqual([
      { serviceId: "test-service", apiKeySha256: "a".repeat(64) },
    ]);
  });

  test("fails before startup when stale timeout is incompatible with retry deadline", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        SERVICE_CREDENTIALS: serviceCredentials,
        IDEMPOTENCY_PROCESSING_TIMEOUT_MS: "15000",
      }),
    ).toThrow("stale timeout");
  });

  test("rejects invalid breaker configuration before startup", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "redis://localhost:6379",
        SERVICE_CREDENTIALS: serviceCredentials,
        PROVIDER_BREAKER_FAILURE_THRESHOLD: "0",
      }),
    ).toThrow("failureThreshold");
  });

  test("requires a valid Redis URL without exposing its value", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        SERVICE_CREDENTIALS: serviceCredentials,
      }),
    ).toThrow("REDIS_URL is required");
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "https://user:secret@example.com",
        SERVICE_CREDENTIALS: serviceCredentials,
      }),
    ).toThrow("supported Redis protocol");
  });

  test("requires valid service credentials without exposing configuration values", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/test",
      REDIS_URL: "redis://localhost:6379",
    };
    expect(() => loadConfig(base)).toThrow("SERVICE_CREDENTIALS is required");
    expect(() =>
      loadConfig({ ...base, SERVICE_CREDENTIALS: "not-json-secret-value" }),
    ).toThrow("SERVICE_CREDENTIALS must be valid JSON");
    expect(() =>
      loadConfig({
        ...base,
        SERVICE_CREDENTIALS: JSON.stringify([
          { serviceId: "invalid service", apiKeySha256: "secret-hash" },
        ]),
      }),
    ).toThrow("SERVICE_CREDENTIALS is invalid");
  });

  test("rejects duplicate service identities and invalid body limits", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/test",
      REDIS_URL: "redis://localhost:6379",
    };
    const duplicateCredentials = JSON.stringify([
      { serviceId: "duplicate", apiKeySha256: "a".repeat(64) },
      { serviceId: "duplicate", apiKeySha256: "b".repeat(64) },
    ]);
    expect(() =>
      loadConfig({ ...base, SERVICE_CREDENTIALS: duplicateCredentials }),
    ).toThrow("duplicate identities");
    expect(() =>
      loadConfig({
        ...base,
        SERVICE_CREDENTIALS: serviceCredentials,
        HTTP_MAX_BODY_BYTES: "0",
      }),
    ).toThrow("positive safe integer");
  });
});
