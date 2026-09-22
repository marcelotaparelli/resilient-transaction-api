import type { RateLimiter, RateLimitResult } from "../../application/ports/rate-limiter";
import type { TransactionCache } from "../../application/ports/transaction-cache";
import type { Transaction } from "../../domain/transaction";
import type { ApplicationMetrics } from "./metrics";
import type { OperationalLogger } from "./logger";
import { noOpLogger } from "./logger";
import { currentRequestId } from "./request-context";

export class ObservedTransactionCache implements TransactionCache {
  constructor(
    private readonly cache: TransactionCache,
    private readonly metrics: ApplicationMetrics,
    private readonly logger: OperationalLogger = noOpLogger,
  ) {}

  async get(transactionId: string): Promise<Transaction | null> {
    try {
      const transaction = await this.cache.get(transactionId);
      if (transaction === null) {
        this.metrics.cacheMiss();
        this.logger.log("info", "cache.miss", { requestId: currentRequestId() });
      } else {
        this.metrics.cacheHit();
        this.logger.log("info", "cache.hit", { requestId: currentRequestId() });
      }
      return transaction;
    } catch (error: unknown) {
      this.metrics.cacheError("get");
      this.logger.log("warn", "cache.error", {
        requestId: currentRequestId(),
        operation: "get",
      });
      throw error;
    }
  }

  async set(transaction: Transaction): Promise<void> {
    try {
      await this.cache.set(transaction);
    } catch (error: unknown) {
      this.metrics.cacheError("set");
      this.logger.log("warn", "cache.error", {
        requestId: currentRequestId(),
        operation: "set",
      });
      throw error;
    }
  }
}

export class ObservedRateLimiter implements RateLimiter {
  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly metrics: ApplicationMetrics,
  ) {}

  async consume(subjectId: string): Promise<RateLimitResult> {
    const result = await this.rateLimiter.consume(subjectId);
    if (!result.allowed) this.metrics.rateLimitRejected();
    return result;
  }
}
