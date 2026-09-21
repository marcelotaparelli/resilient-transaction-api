import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import { InMemoryTransactionRepository } from "../../src/infrastructure/repositories/in-memory-transaction-repository";

const first: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 100,
  currency: "BRL",
  description: "First",
  status: "approved",
  providerTransactionId: "provider-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const second: Transaction = {
  id: "00000000-0000-4000-8000-000000000002",
  amount: 200,
  currency: "BRL",
  description: "Second",
  status: "approved",
  providerTransactionId: "provider-2",
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("InMemoryTransactionRepository", () => {
  test("finds by ID and idempotency key, lists in stable newest-first order, and counts", async () => {
    const repository = new InMemoryTransactionRepository();

    await repository.save("key-1", first);
    await repository.save("key-2", second);

    expect(await repository.findById(first.id)).toEqual(first);
    expect(await repository.findByIdempotencyKey("key-1")).toEqual(first);
    expect(await repository.list(0, 1)).toEqual([second]);
    expect(await repository.list(1, 1)).toEqual([first]);
    expect(await repository.count()).toBe(2);
  });
});
