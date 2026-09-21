import { describe, expect, test } from "bun:test";
import { ProviderServerError } from "../../src/application/errors/provider-errors";
import {
  calculateMaximumRetryWindowMs,
  RetryPolicy,
  validateProviderTiming,
} from "../../src/infrastructure/providers/retry-policy";

const config = {
  maxAttempts: 3,
  attemptTimeoutMs: 3_000,
  baseDelayMs: 500,
  maxDelayMs: 2_000,
  jitterRatio: 0.2,
};

describe("RetryPolicy", () => {
  test("calculates bounded exponential backoff with deterministic jitter", () => {
    const policy = new RetryPolicy(config);

    expect(policy.delayAfter(1, 0)).toBe(500);
    expect(policy.delayAfter(1, 1)).toBe(600);
    expect(policy.delayAfter(2, 0.5)).toBe(1_100);
    expect(policy.delayAfter(3, 1)).toBe(2_000);
  });

  test("bounds attempts and only retries classified transient failures", () => {
    const policy = new RetryPolicy(config);

    expect(policy.shouldRetry(new ProviderServerError(503), 1)).toBeTrue();
    expect(policy.shouldRetry(new ProviderServerError(503), 3)).toBeFalse();
    expect(policy.shouldRetry(new ProviderServerError(501), 1)).toBeFalse();
  });

  test("derives the worst-case execution window and stale margin", () => {
    expect(calculateMaximumRetryWindowMs(config)).toBe(10_800);
    expect(
      validateProviderTiming({
        retry: config,
        executionOverheadMs: 2_000,
        processingStaleTimeoutMs: 30_000,
        minimumStaleMarginMs: 3_000,
      }),
    ).toEqual({
      maximumRetryWindowMs: 10_800,
      maximumProviderExecutionWindowMs: 12_800,
      staleMarginMs: 17_200,
    });
  });

  test("fails fast when the processing lease cannot cover the retry deadline", () => {
    expect(() =>
      validateProviderTiming({
        retry: config,
        executionOverheadMs: 2_000,
        processingStaleTimeoutMs: 15_000,
        minimumStaleMarginMs: 3_000,
      }),
    ).toThrow("stale timeout");
  });
});
