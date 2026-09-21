import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("centralizes validated provider resilience defaults", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/test" });

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
  });

  test("fails before startup when stale timeout is incompatible with retry deadline", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        IDEMPOTENCY_PROCESSING_TIMEOUT_MS: "15000",
      }),
    ).toThrow("stale timeout");
  });

  test("rejects invalid breaker configuration before startup", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        PROVIDER_BREAKER_FAILURE_THRESHOLD: "0",
      }),
    ).toThrow("failureThreshold");
  });
});
