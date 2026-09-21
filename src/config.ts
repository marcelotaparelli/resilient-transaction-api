import {
  type CircuitBreakerConfig,
  validateCircuitBreakerConfig,
} from "./infrastructure/providers/circuit-breaker";
import {
  type ProviderTimingConfig,
  type RetryPolicyConfig,
  validateProviderTiming,
} from "./infrastructure/providers/retry-policy";

export type ApplicationConfig = {
  databaseUrl: string;
  redisUrl: string;
  redisCommandTimeoutMs: number;
  transactionCacheTtlSeconds: number;
  transactionCacheKeyPrefix: string;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  rateLimitKeyPrefix: string;
  providerUrl: string;
  retry: RetryPolicyConfig;
  breaker: CircuitBreakerConfig;
  processingStaleTimeoutMs: number;
  executionOverheadMs: number;
  minimumStaleMarginMs: number;
};

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function number(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name] ?? String(fallback));
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function positiveInteger(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = number(environment, name, fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function redisUrl(environment: Record<string, string | undefined>): string {
  const value = required(environment, "REDIS_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("REDIS_URL must be a valid Redis URL");
  }

  if (
    !["redis:", "rediss:", "redis+tls:"].includes(parsed.protocol)
  ) {
    throw new Error("REDIS_URL must use a supported Redis protocol");
  }
  return value;
}

function timing(config: ApplicationConfig): ProviderTimingConfig {
  return {
    retry: config.retry,
    executionOverheadMs: config.executionOverheadMs,
    processingStaleTimeoutMs: config.processingStaleTimeoutMs,
    minimumStaleMarginMs: config.minimumStaleMarginMs,
  };
}

export function loadConfig(
  environment: Record<string, string | undefined>,
): ApplicationConfig {
  const providerUrl = environment.PROVIDER_URL ?? "http://localhost:4003/transactions";
  try {
    new URL(providerUrl);
  } catch {
    throw new Error("PROVIDER_URL must be a valid URL");
  }

  const config: ApplicationConfig = {
    databaseUrl: required(environment, "DATABASE_URL"),
    redisUrl: redisUrl(environment),
    redisCommandTimeoutMs: positiveInteger(
      environment,
      "REDIS_COMMAND_TIMEOUT_MS",
      250,
    ),
    transactionCacheTtlSeconds: positiveInteger(
      environment,
      "TRANSACTION_CACHE_TTL_SECONDS",
      3_600,
    ),
    transactionCacheKeyPrefix:
      environment.TRANSACTION_CACHE_KEY_PREFIX ?? "transaction-cache:v1",
    rateLimitMaxRequests: positiveInteger(
      environment,
      "RATE_LIMIT_MAX_REQUESTS",
      5,
    ),
    rateLimitWindowMs: positiveInteger(
      environment,
      "RATE_LIMIT_WINDOW_MS",
      60_000,
    ),
    rateLimitKeyPrefix:
      environment.RATE_LIMIT_KEY_PREFIX ?? "rate-limit:v1",
    providerUrl,
    retry: {
      maxAttempts: number(environment, "PROVIDER_MAX_ATTEMPTS", 3),
      attemptTimeoutMs: number(environment, "PROVIDER_TIMEOUT_MS", 3_000),
      baseDelayMs: number(environment, "PROVIDER_BASE_DELAY_MS", 500),
      maxDelayMs: number(environment, "PROVIDER_MAX_DELAY_MS", 2_000),
      jitterRatio: number(environment, "PROVIDER_JITTER_RATIO", 0.2),
    },
    breaker: {
      failureThreshold: number(
        environment,
        "PROVIDER_BREAKER_FAILURE_THRESHOLD",
        3,
      ),
      openDurationMs: number(
        environment,
        "PROVIDER_BREAKER_OPEN_DURATION_MS",
        10_000,
      ),
    },
    processingStaleTimeoutMs: number(
      environment,
      "IDEMPOTENCY_PROCESSING_TIMEOUT_MS",
      30_000,
    ),
    executionOverheadMs: number(
      environment,
      "PROVIDER_EXECUTION_OVERHEAD_MS",
      2_000,
    ),
    minimumStaleMarginMs: number(
      environment,
      "IDEMPOTENCY_MINIMUM_STALE_MARGIN_MS",
      3_000,
    ),
  };

  validateProviderTiming(timing(config));
  validateCircuitBreakerConfig(config.breaker);
  return config;
}
