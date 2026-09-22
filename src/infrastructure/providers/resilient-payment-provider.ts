import {
  ProviderCircuitOpenError,
  ProviderTimeoutError,
} from "../../application/errors/provider-errors";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../application/ports/payment-provider";
import type { TransactionInput } from "../../domain/transaction";
import type { CircuitBreaker } from "./circuit-breaker";
import { classifyProviderFailure } from "./provider-failure-policy";
import type { RandomSource, Sleeper } from "./retry-policy";
import { RetryPolicy } from "./retry-policy";
import type { OperationalLogger } from "../observability/logger";
import { noOpLogger } from "../observability/logger";
import type { ApplicationMetrics } from "../observability/metrics";
import { currentRequestId } from "../observability/request-context";

export class ResilientPaymentProvider implements PaymentProvider {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly retryPolicy: RetryPolicy,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly sleeper: Sleeper,
    private readonly randomSource: RandomSource,
    private readonly metrics?: ApplicationMetrics,
    private readonly logger: OperationalLogger = noOpLogger,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async process(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    const permit = this.circuitBreaker.acquire();
    if (permit === null) {
      this.logger.log("warn", "provider.circuit_rejected", {
        requestId: currentRequestId(),
      });
      throw new ProviderCircuitOpenError();
    }

    for (
      let attempt = 1;
      attempt <= this.retryPolicy.config.maxAttempts;
      attempt += 1
    ) {
      const startedAt = this.monotonicNow();
      try {
        const result = await this.provider.process(transaction, idempotencyKey);
        this.circuitBreaker.recordSuccess(permit);
        this.logger.log("info", "provider.request", {
          requestId: currentRequestId(),
          attempt,
          durationMs: Math.max(0, this.monotonicNow() - startedAt),
        });
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderTimeoutError) {
          this.logger.log("warn", "provider.timeout", {
            requestId: currentRequestId(),
            attempt,
            durationMs: Math.max(0, this.monotonicNow() - startedAt),
          });
        }
        if (this.retryPolicy.shouldRetry(error, attempt)) {
          const delayMs = this.retryPolicy.delayAfter(
            attempt,
            this.randomSource.next(),
          );
          this.metrics?.providerRetry();
          this.logger.log("warn", "provider.retry", {
            requestId: currentRequestId(),
            attempt,
            delayMs,
            durationMs: Math.max(0, this.monotonicNow() - startedAt),
          });
          await this.sleeper.sleep(delayMs);
          continue;
        }

        const failure = classifyProviderFailure(error);
        if (failure.countsTowardCircuitBreaker) {
          this.circuitBreaker.recordFailure(permit);
        } else {
          this.circuitBreaker.recordNonFailure(permit);
        }
        this.logger.log("warn", "provider.failure", {
          requestId: currentRequestId(),
          attempt,
          durationMs: Math.max(0, this.monotonicNow() - startedAt),
        });
        throw error;
      }
    }

    throw new Error("Retry policy completed without a result");
  }
}
