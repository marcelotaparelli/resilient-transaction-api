import { describe, expect, test } from "bun:test";
import { IdempotencyConflictError } from "../../src/application/errors/idempotency-conflict-error";
import { IdempotencyInProgressError } from "../../src/application/errors/idempotency-in-progress-error";
import {
  ProviderCircuitOpenError,
  ProviderInvalidResponseError,
  ProviderRejectedError,
} from "../../src/application/errors/provider-errors";
import type {
  ClaimIdempotencyOperation,
  CompleteIdempotencyOperation,
  IdempotencyClaimResult,
  ReleaseIdempotencyOperation,
} from "../../src/application/models/idempotency-operation";
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
  currency: "brl",
  description: "  Order 123  ",
};

const providerResult: ProviderResult = {
  providerTransactionId: "provider-123",
  decision: "approved",
};

const createdAt = new Date("2026-01-02T03:04:05.000Z");
const approvedTransaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
  providerTransactionId: providerResult.providerTransactionId,
  status: "approved",
  createdAt,
};

class RepositoryStub implements TransactionRepository {
  claimResult: IdempotencyClaimResult = { kind: "new_claim" };
  claimRequest: ClaimIdempotencyOperation | null = null;
  completed: CompleteIdempotencyOperation | null = null;
  released: ReleaseIdempotencyOperation | null = null;

  async claimIdempotencyOperation(
    operation: ClaimIdempotencyOperation,
  ): Promise<IdempotencyClaimResult> {
    this.claimRequest = operation;
    return this.claimResult;
  }

  async completeIdempotencyOperation(
    operation: CompleteIdempotencyOperation,
  ): Promise<void> {
    this.completed = operation;
  }

  async releaseIdempotencyOperation(
    operation: ReleaseIdempotencyOperation,
  ): Promise<void> {
    this.released = operation;
  }

  async findById(): Promise<Transaction | null> {
    return null;
  }

  async list(): Promise<Transaction[]> {
    return [];
  }

  async count(): Promise<number> {
    return 0;
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
    30_000,
  );
}

describe("CreateTransaction", () => {
  test("a new claim calls the provider once and completes the operation", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    const result = await useCase.execute(input, "idempotency-key");

    expect(result).toEqual({ transaction: approvedTransaction, created: true });
    expect(provider.calls).toBe(1);
    expect(repository.claimRequest).toMatchObject({
      idempotencyKey: "idempotency-key",
      requestFingerprint:
        "a2e97cad2002b1babda12974e1821c08b3e416573a9bdcb33b74b6b4852ae10f",
      claimedAt: createdAt,
      staleBefore: new Date("2026-01-02T03:03:35.000Z"),
    });
    expect(repository.completed).toEqual({
      idempotencyKey: "idempotency-key",
      requestFingerprint:
        "a2e97cad2002b1babda12974e1821c08b3e416573a9bdcb33b74b6b4852ae10f",
      transaction: approvedTransaction,
      completedAt: createdAt,
    });
  });

  test("completed replay returns the stored transaction without calling the provider", async () => {
    const repository = new RepositoryStub();
    repository.claimResult = {
      kind: "completed_replay",
      transaction: approvedTransaction,
    };
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    const result = await useCase.execute(input, "idempotency-key");

    expect(result).toEqual({ transaction: approvedTransaction, created: false });
    expect(provider.calls).toBe(0);
    expect(repository.completed).toBeNull();
  });

  test("fingerprint conflict fails without calling the provider", async () => {
    const repository = new RepositoryStub();
    repository.claimResult = { kind: "fingerprint_conflict" };
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(provider.calls).toBe(0);
  });

  test("an active processing operation fails immediately without polling", async () => {
    const repository = new RepositoryStub();
    repository.claimResult = { kind: "processing" };
    const provider = new ProviderStub();
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(provider.calls).toBe(0);
  });

  test("definitive provider rejection releases the claim for a safe retry", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    provider.error = new ProviderRejectedError();
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
    expect(repository.completed).toBeNull();
    expect(repository.released).toEqual({
      idempotencyKey: "idempotency-key",
      requestFingerprint:
        "a2e97cad2002b1babda12974e1821c08b3e416573a9bdcb33b74b6b4852ae10f",
    });
  });

  test("ambiguous provider failure keeps the operation processing", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    provider.error = new Error("outcome unknown");
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toThrow("outcome unknown");
    expect(repository.completed).toBeNull();
    expect(repository.released).toBeNull();
  });

  test("an invalid provider response remains ambiguous and keeps processing", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    provider.error = new ProviderInvalidResponseError();
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toBeInstanceOf(ProviderInvalidResponseError);
    expect(repository.completed).toBeNull();
    expect(repository.released).toBeNull();
  });

  test("a circuit-open refusal releases a new claim because no provider call started", async () => {
    const repository = new RepositoryStub();
    const provider = new ProviderStub();
    provider.error = new ProviderCircuitOpenError();
    const useCase = createUseCase(repository, provider);

    await expect(
      useCase.execute(input, "idempotency-key"),
    ).rejects.toBeInstanceOf(ProviderCircuitOpenError);
    expect(repository.completed).toBeNull();
    expect(repository.released?.idempotencyKey).toBe("idempotency-key");
  });
});
