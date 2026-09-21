import { z } from "zod";
import type { TransactionCache } from "../../application/ports/transaction-cache";
import type { Transaction } from "../../domain/transaction";
import type {
  RedisCommandExecutor,
  RedisFailureReporter,
} from "../redis/redis-client";
import { transactionCacheKey } from "../redis/redis-keys";

const cachedTransactionSchema = z
  .object({
    id: z.string().uuid(),
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    description: z.string().min(1).max(200),
    providerTransactionId: z.string().min(1).max(200),
    status: z.literal("approved"),
    createdAt: z.string().datetime(),
  })
  .strict();

export class InvalidTransactionCacheEntryError extends Error {
  constructor() {
    super("Transaction cache entry is invalid");
    this.name = "InvalidTransactionCacheEntryError";
  }
}

export class RedisTransactionCache implements TransactionCache {
  constructor(
    private readonly redis: RedisCommandExecutor,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number,
    private readonly reportFailure: RedisFailureReporter = () => {},
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error("Transaction cache TTL must be a positive safe integer");
    }

    transactionCacheKey(keyPrefix, "validation");
  }

  async get(transactionId: string): Promise<Transaction | null> {
    try {
      return await this.read(transactionId);
    } catch (error: unknown) {
      this.safeReportFailure("transaction_cache_read");
      throw error;
    }
  }

  async set(transaction: Transaction): Promise<void> {
    try {
      await this.write(transaction);
    } catch (error: unknown) {
      this.safeReportFailure("transaction_cache_write");
      throw error;
    }
  }

  private async read(transactionId: string): Promise<Transaction | null> {
    const key = transactionCacheKey(this.keyPrefix, transactionId);
    const raw = await this.redis.execute(() =>
      this.redis.client.send("GET", [key]),
    );

    if (raw === null) {
      return null;
    }

    if (typeof raw !== "string") {
      await this.removeInvalidEntry(key);
      throw new InvalidTransactionCacheEntryError();
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      await this.removeInvalidEntry(key);
      throw new InvalidTransactionCacheEntryError();
    }

    const parsed = cachedTransactionSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== transactionId) {
      await this.removeInvalidEntry(key);
      throw new InvalidTransactionCacheEntryError();
    }

    return {
      ...parsed.data,
      createdAt: new Date(parsed.data.createdAt),
    };
  }

  private async write(transaction: Transaction): Promise<void> {
    const value = cachedTransactionSchema.parse({
      ...transaction,
      createdAt: transaction.createdAt.toISOString(),
    });
    const key = transactionCacheKey(this.keyPrefix, transaction.id);
    await this.redis.execute(() =>
      this.redis.client.send("SET", [
        key,
        JSON.stringify(value),
        "EX",
        String(this.ttlSeconds),
      ]),
    );
  }

  private async removeInvalidEntry(key: string): Promise<void> {
    try {
      await this.redis.execute(() => this.redis.client.send("DEL", [key]));
    } catch {
      // The caller still falls back to PostgreSQL even if cleanup fails.
    }
  }

  private safeReportFailure(operation: string): void {
    try {
      this.reportFailure(operation);
    } catch {
      // Failure reporting must not change cache failure semantics.
    }
  }
}
