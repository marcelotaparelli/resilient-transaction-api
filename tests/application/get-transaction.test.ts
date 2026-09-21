import { describe, expect, test } from "bun:test";
import { TransactionNotFoundError } from "../../src/application/errors/transaction-not-found-error";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
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
    findById: async () => result,
    findByIdempotencyKey: async () => null,
    save: async () => {},
    list: async () => [],
    count: async () => 0,
  };
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
});
