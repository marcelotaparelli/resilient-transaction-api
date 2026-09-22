import {
  type CircuitBreakerConfig,
  validateCircuitBreakerConfig,
} from "./infrastructure/providers/circuit-breaker";
import {
  type ProviderTimingConfig,
  type RetryPolicyConfig,
  validateProviderTiming,
} from "./infrastructure/providers/retry-policy";
import { z } from "zod";
import type { ServiceCredentialConfig } from "./http/security/service-authenticator";

const serviceCredentialsSchema = z
  .array(
    z
      .object({
        serviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        apiKeySha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      })
      .strict(),
  )
  .min(1)
  .max(100);

export type ApplicationConfig = {
  httpHost: string;
  httpPort: number;
  serviceCredentials: ServiceCredentialConfig[];
  httpMaxBodyBytes: number;
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
  readinessTimeoutMs: number;
  shutdownGracePeriodMs: number;
};

function serviceCredentials(
  environment: Record<string, string | undefined>,
): ServiceCredentialConfig[] {
  const raw = required(environment, "SERVICE_CREDENTIALS");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SERVICE_CREDENTIALS must be valid JSON");
  }

  const parsed = serviceCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("SERVICE_CREDENTIALS is invalid");
  }

  const serviceIds = new Set<string>();
  const hashes = new Set<string>();
  for (const credential of parsed.data) {
    const hash = credential.apiKeySha256.toLowerCase();
    if (serviceIds.has(credential.serviceId) || hashes.has(hash)) {
      throw new Error("SERVICE_CREDENTIALS contains duplicate identities");
    }
    serviceIds.add(credential.serviceId);
    hashes.add(hash);
  }

  return parsed.data.map((credential) => ({
    serviceId: credential.serviceId,
    apiKeySha256: credential.apiKeySha256.toLowerCase(),
  }));
}

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

function httpPort(
  environment: Record<string, string | undefined>,
): number {
  const value = positiveInteger(environment, "PORT", 4_002);
  if (value > 65_535) {
    throw new Error("PORT must be between 1 and 65535");
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
    httpHost: environment.HTTP_HOST?.trim() || "0.0.0.0",
    httpPort: httpPort(environment),
    serviceCredentials: serviceCredentials(environment),
    httpMaxBodyBytes: positiveInteger(
      environment,
      "HTTP_MAX_BODY_BYTES",
      16_384,
    ),
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
    readinessTimeoutMs: positiveInteger(
      environment,
      "READINESS_TIMEOUT_MS",
      500,
    ),
    shutdownGracePeriodMs: positiveInteger(
      environment,
      "SHUTDOWN_GRACE_PERIOD_MS",
      15_000,
    ),
  };

  const providerTiming = validateProviderTiming(timing(config));
  if (
    config.shutdownGracePeriodMs <
    providerTiming.maximumProviderExecutionWindowMs
  ) {
    throw new Error(
      "Shutdown grace period must cover the maximum provider execution window",
    );
  }
  validateCircuitBreakerConfig(config.breaker);
  return config;
}
