import { ProviderCircuitOpenError } from "../../application/errors/provider-errors";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../application/ports/payment-provider";
import type { TransactionInput } from "../../domain/transaction";
import type { CircuitBreaker } from "./circuit-breaker";
import { classifyProviderFailure } from "./provider-failure-policy";
import type { RandomSource, Sleeper } from "./retry-policy";
import { RetryPolicy } from "./retry-policy";

export class ResilientPaymentProvider implements PaymentProvider {
  constructor(
    private readonly provider: PaymentProvider,
    private readonly retryPolicy: RetryPolicy,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly sleeper: Sleeper,
    private readonly randomSource: RandomSource,
  ) {}

  async process(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    const permit = this.circuitBreaker.acquire();
    if (permit === null) {
      throw new ProviderCircuitOpenError();
    }

    for (
      let attempt = 1;
      attempt <= this.retryPolicy.config.maxAttempts;
      attempt += 1
    ) {
      try {
        const result = await this.provider.process(transaction, idempotencyKey);
        this.circuitBreaker.recordSuccess(permit);
        return result;
      } catch (error: unknown) {
        if (this.retryPolicy.shouldRetry(error, attempt)) {
          const delayMs = this.retryPolicy.delayAfter(
            attempt,
            this.randomSource.next(),
          );
          await this.sleeper.sleep(delayMs);
          continue;
        }

        const failure = classifyProviderFailure(error);
        if (failure.countsTowardCircuitBreaker) {
          this.circuitBreaker.recordFailure(permit);
        } else {
          this.circuitBreaker.recordNonFailure(permit);
        }
        throw error;
      }
    }

    throw new Error("Retry policy completed without a result");
  }
}
