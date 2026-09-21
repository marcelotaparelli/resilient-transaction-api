import { describe, expect, test } from "bun:test";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../src/application/ports/payment-provider";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
import { CreateTransaction } from "../../src/application/use-cases/create-transaction";
import type {
  Transaction,
  TransactionInput,
} from "../../src/domain/transaction";

const input: TransactionInput = {
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
};

const providerResult: ProviderResult = {
  providerTransactionId: "provider-123",
  decision: "approved",
};

const createdAt = new Date("2026-01-02T03:04:05.000Z");
const approvedTransaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  ...input,
  providerTransactionId: providerResult.providerTransactionId,
  status: "approved",
  createdAt,
};

class RepositoryStub implements TransactionRepository {
  stored: Transaction | null = null;

  async findById(transactionId: string): Promise<Transaction | null> {
    return this.stored?.id === transactionId ? this.stored : null;
  }

  async findByIdempotencyKey(): Promise<Transaction | null> {
    return this.stored;
  }

  async save(
    _idempotencyKey: string,
    transaction: Transaction,
  ): Promise<void> {
    this.stored = transaction;
  }

  async list(): Promise<Transaction[]> {
    return this.stored === null ? [] : [this.stored];
  }

  async count(): Promise<number> {
    return this.stored === null ? 0 : 1;
  }
}

class ProviderStub implements PaymentProvider {
  calls = 0;
  error: Error | null = null;

  async process(): Promise<ProviderResult> {
    this.calls += 1;
    if (this.error !== null) {
      throw this.error;
    }

    return providerResult;
  }
}

function createUseCase(
  repository: TransactionRepository,
  provider: PaymentProvider,
): CreateTransaction {
  return new CreateTransaction(
    repository,
    provider,
    { generate: () => approvedTransaction.id },
    { now: () => createdAt },
  );
}

describe("CreateTransaction", () => {
  test("successful creation calls the provider once and builds the internal transaction", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    const result = await useCase.execute(input, "idempotency-key");

    expect(result).toEqual({ transaction: approvedTransaction, created: true });
    expect(provider.calls).toBe(1);
    expect(repository.stored).toEqual(approvedTransaction);
  });

  test("sequential replay returns the stored result without calling the provider", async () => {
    const repository = new RepositoryStub();
    repository.stored = approvedTransaction;
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    const result = await useCase.execute(input, "idempotency-key");

    expect(result).toEqual({ transaction: approvedTransaction, created: false });
    expect(provider.calls).toBe(0);
  });

  test("provider failure does not save an approved transaction", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    provider.error = new Error("provider failed");
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toThrow("provider failed");
    expect(repository.stored).toBeNull();
  });
});
