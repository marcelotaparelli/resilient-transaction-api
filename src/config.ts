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
