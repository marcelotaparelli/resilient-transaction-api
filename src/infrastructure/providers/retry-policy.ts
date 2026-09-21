import { classifyProviderFailure } from "./provider-failure-policy";

export interface Sleeper {
  sleep(delayMs: number): Promise<void>;
}

export interface RandomSource {
  next(): number;
}

export type RetryPolicyConfig = {
  maxAttempts: number;
  attemptTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

function requireSafeInteger(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

export function validateRetryPolicyConfig(config: RetryPolicyConfig): void {
  requireSafeInteger("maxAttempts", config.maxAttempts, 1);
  if (config.maxAttempts > 10) {
    throw new Error("maxAttempts must be less than or equal to 10");
  }
  requireSafeInteger("attemptTimeoutMs", config.attemptTimeoutMs, 1);
  requireSafeInteger("baseDelayMs", config.baseDelayMs, 0);
  requireSafeInteger("maxDelayMs", config.maxDelayMs, 0);

  if (config.maxDelayMs < config.baseDelayMs) {
    throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");
  }

  if (
    !Number.isFinite(config.jitterRatio) ||
    config.jitterRatio < 0 ||
    config.jitterRatio > 1
  ) {
    throw new Error("jitterRatio must be between 0 and 1");
  }
}

function requireRandomValue(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("RandomSource.next() must return a number between 0 and 1");
  }
}

export class RetryPolicy {
  constructor(readonly config: RetryPolicyConfig) {
    validateRetryPolicyConfig(config);
  }

  shouldRetry(error: unknown, failedAttempt: number): boolean {
    return (
      failedAttempt < this.config.maxAttempts &&
      classifyProviderFailure(error).retryable
    );
  }

  delayAfter(failedAttempt: number, randomValue: number): number {
    requireSafeInteger("failedAttempt", failedAttempt, 1);
    requireRandomValue(randomValue);

    const exponential =
      this.config.baseDelayMs * 2 ** (failedAttempt - 1);
    const jittered = exponential * (1 + this.config.jitterRatio * randomValue);
    return Math.min(this.config.maxDelayMs, Math.round(jittered));
  }

  maximumRetryDelayAfter(failedAttempt: number): number {
    return this.delayAfter(failedAttempt, 1);
  }
}

export function calculateMaximumRetryWindowMs(
  config: RetryPolicyConfig,
): number {
  const policy = new RetryPolicy(config);
  let total = config.maxAttempts * config.attemptTimeoutMs;

  for (let attempt = 1; attempt < config.maxAttempts; attempt += 1) {
    total += policy.maximumRetryDelayAfter(attempt);
  }

  if (!Number.isSafeInteger(total)) {
    throw new Error("Maximum retry window exceeds the safe integer range");
  }

  return total;
}

export type ProviderTimingConfig = {
  retry: RetryPolicyConfig;
  executionOverheadMs: number;
  processingStaleTimeoutMs: number;
  minimumStaleMarginMs: number;
};

export function validateProviderTiming(config: ProviderTimingConfig): {
  maximumRetryWindowMs: number;
  maximumProviderExecutionWindowMs: number;
  staleMarginMs: number;
} {
  requireSafeInteger("executionOverheadMs", config.executionOverheadMs, 0);
  requireSafeInteger(
    "processingStaleTimeoutMs",
    config.processingStaleTimeoutMs,
    1,
  );
  requireSafeInteger("minimumStaleMarginMs", config.minimumStaleMarginMs, 1);

  const maximumRetryWindowMs = calculateMaximumRetryWindowMs(config.retry);
  const maximumProviderExecutionWindowMs =
    maximumRetryWindowMs + config.executionOverheadMs;
  const staleMarginMs =
    config.processingStaleTimeoutMs - maximumProviderExecutionWindowMs;

  if (staleMarginMs < config.minimumStaleMarginMs) {
    throw new Error(
      "Idempotency processing stale timeout must exceed the maximum provider execution window by the configured safety margin",
    );
  }

  return {
    maximumRetryWindowMs,
    maximumProviderExecutionWindowMs,
    staleMarginMs,
  };
}
