import {
  ProviderCircuitOpenError,
  ProviderInvalidResponseError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../application/errors/provider-errors";

export type ProviderFailureDecision = {
  retryable: boolean;
  countsTowardCircuitBreaker: boolean;
  outcome: "ambiguous" | "definitive_rejection" | "not_started";
};

const retryableServerStatuses = new Set([500, 502, 503, 504]);

export function classifyProviderFailure(
  error: unknown,
): ProviderFailureDecision {
  if (error instanceof ProviderCircuitOpenError) {
    return {
      retryable: false,
      countsTowardCircuitBreaker: false,
      outcome: "not_started",
    };
  }

  if (error instanceof ProviderRejectedError) {
    return {
      retryable: false,
      countsTowardCircuitBreaker: false,
      outcome: "definitive_rejection",
    };
  }

  if (error instanceof ProviderRateLimitedError) {
    return {
      retryable: true,
      countsTowardCircuitBreaker: false,
      outcome: "ambiguous",
    };
  }

  if (error instanceof ProviderServerError) {
    return {
      retryable: retryableServerStatuses.has(error.status),
      countsTowardCircuitBreaker: true,
      outcome: "ambiguous",
    };
  }

  if (
    error instanceof ProviderTimeoutError ||
    error instanceof ProviderNetworkError ||
    error instanceof ProviderUnavailableError
  ) {
    return {
      retryable: true,
      countsTowardCircuitBreaker: true,
      outcome: "ambiguous",
    };
  }

  if (error instanceof ProviderInvalidResponseError) {
    return {
      retryable: false,
      countsTowardCircuitBreaker: true,
      outcome: "ambiguous",
    };
  }

  return {
    retryable: false,
    countsTowardCircuitBreaker: false,
    outcome: "ambiguous",
  };
}
