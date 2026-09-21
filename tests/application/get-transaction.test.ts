import { describe, expect, test } from "bun:test";
import { TransactionNotFoundError } from "../../src/application/errors/transaction-not-found-error";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
import type { TransactionCache } from "../../src/application/ports/transaction-cache";
import { GetTransaction } from "../../src/application/use-cases/get-transaction";
import type { Transaction } from "../../src/domain/transaction";

const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
  status: "approved",
  providerTransactionId: "provider-123",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

function repositoryReturning(
  result: Transaction | null,
): TransactionRepository {
  return {
    claimIdempotencyOperation: async () => ({ kind: "new_claim" }),
    completeIdempotencyOperation: async () => {},
    releaseIdempotencyOperation: async () => {},
    findById: async () => result,
    list: async () => [],
    count: async () => 0,
  };
}

class CacheStub implements TransactionCache {
  value: Transaction | null = null;
  getError: Error | null = null;
  setError: Error | null = null;
  getCalls = 0;
  setCalls: Transaction[] = [];

  async get(): Promise<Transaction | null> {
    this.getCalls += 1;
    if (this.getError !== null) throw this.getError;
    return this.value;
  }

  async set(value: Transaction): Promise<void> {
    this.setCalls.push(value);
    if (this.setError !== null) throw this.setError;
  }
}

function countingRepository(result: Transaction | null): {
  repository: TransactionRepository;
  findCalls: () => number;
} {
  let calls = 0;
  const repository = repositoryReturning(result);
  repository.findById = async () => {
    calls += 1;
    return result;
  };
  return { repository, findCalls: () => calls };
}

describe("GetTransaction", () => {
  test("returns a transaction found by its internal ID", async () => {
    const useCase = new GetTransaction(repositoryReturning(transaction));

    expect(await useCase.execute(transaction.id)).toEqual(transaction);
  });

  test("throws a semantic error when the transaction does not exist", async () => {
    const useCase = new GetTransaction(repositoryReturning(null));

    await expect(useCase.execute(transaction.id)).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
  });

  test("returns a cache hit without consulting PostgreSQL", async () => {
    const cache = new CacheStub();
    cache.value = transaction;
    const { repository, findCalls } = countingRepository(null);
    const useCase = new GetTransaction(repository, cache);

    expect(await useCase.execute(transaction.id)).toEqual(transaction);
    expect(cache.getCalls).toBe(1);
    expect(findCalls()).toBe(0);
  });

  test("populates cache after a PostgreSQL cache miss", async () => {
    const cache = new CacheStub();
    const { repository, findCalls } = countingRepository(transaction);
    const useCase = new GetTransaction(repository, cache);

    expect(await useCase.execute(transaction.id)).toEqual(transaction);
    expect(findCalls()).toBe(1);
    expect(cache.setCalls).toEqual([transaction]);
  });

  test("falls back to PostgreSQL when cache read or write fails", async () => {
    const readFailure = new CacheStub();
    readFailure.getError = new Error("redis unavailable");
    const first = countingRepository(transaction);
    expect(
      await new GetTransaction(first.repository, readFailure).execute(
        transaction.id,
      ),
    ).toEqual(transaction);
    expect(first.findCalls()).toBe(1);

    const writeFailure = new CacheStub();
    writeFailure.setError = new Error("redis unavailable");
    const second = countingRepository(transaction);
    expect(
      await new GetTransaction(second.repository, writeFailure).execute(
        transaction.id,
      ),
    ).toEqual(transaction);
  });

  test("does not negative-cache a PostgreSQL miss", async () => {
    const cache = new CacheStub();
    const useCase = new GetTransaction(repositoryReturning(null), cache);

    await expect(useCase.execute(transaction.id)).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    expect(cache.setCalls).toEqual([]);
  });
});
