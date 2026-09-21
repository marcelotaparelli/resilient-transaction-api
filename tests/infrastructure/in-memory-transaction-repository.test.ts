import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import { InMemoryTransactionRepository } from "../../src/infrastructure/repositories/in-memory-transaction-repository";

const fingerprint = "a".repeat(64);
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

async function complete(
  repository: InMemoryTransactionRepository,
  key: string,
  transaction: Transaction,
): Promise<void> {
  const claimedAt = transaction.createdAt;
  await repository.claimIdempotencyOperation({
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    claimedAt,
    staleBefore: new Date(claimedAt.getTime() - 30_000),
  });
  await repository.completeIdempotencyOperation({
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    transaction,
    completedAt: claimedAt,
  });
}

describe("InMemoryTransactionRepository", () => {
  test("persists completed operations and lists transactions newest first", async () => {
    const repository = new InMemoryTransactionRepository();
    await complete(repository, "key-1", first);
    await complete(repository, "key-2", second);

    expect(await repository.findById(first.id)).toEqual(first);
    expect(
      await repository.claimIdempotencyOperation({
        idempotencyKey: "key-1",
        requestFingerprint: fingerprint,
        claimedAt: new Date("2026-01-03T00:00:00.000Z"),
        staleBefore: new Date("2026-01-02T23:59:30.000Z"),
      }),
    ).toEqual({ kind: "completed_replay", transaction: first });
    expect(await repository.list(0, 1)).toEqual([second]);
    expect(await repository.list(1, 1)).toEqual([first]);
    expect(await repository.count()).toBe(2);
  });

  test("distinguishes conflict from an active operation", async () => {
    const repository = new InMemoryTransactionRepository();
    const claimedAt = new Date("2026-01-01T00:00:00.000Z");
    const firstClaim = await repository.claimIdempotencyOperation({
      idempotencyKey: "key-1",
      requestFingerprint: fingerprint,
      claimedAt,
      staleBefore: new Date("2025-12-31T23:59:30.000Z"),
    });
    const activeClaim = await repository.claimIdempotencyOperation({
      idempotencyKey: "key-1",
      requestFingerprint: fingerprint,
      claimedAt: new Date("2026-01-01T00:00:01.000Z"),
      staleBefore: new Date("2025-12-31T23:59:31.000Z"),
    });
    const conflict = await repository.claimIdempotencyOperation({
      idempotencyKey: "key-1",
      requestFingerprint: "b".repeat(64),
      claimedAt: new Date("2026-01-01T00:00:01.000Z"),
      staleBefore: new Date("2025-12-31T23:59:31.000Z"),
    });

    expect(firstClaim).toEqual({ kind: "new_claim" });
    expect(activeClaim).toEqual({ kind: "processing" });
    expect(conflict).toEqual({ kind: "fingerprint_conflict" });
  });

  test("allows a stale processing operation to be reclaimed", async () => {
    const repository = new InMemoryTransactionRepository();
    await repository.claimIdempotencyOperation({
      idempotencyKey: "key-1",
      requestFingerprint: fingerprint,
      claimedAt: new Date("2026-01-01T00:00:00.000Z"),
      staleBefore: new Date("2025-12-31T23:59:30.000Z"),
    });

    const reclaimed = await repository.claimIdempotencyOperation({
      idempotencyKey: "key-1",
      requestFingerprint: fingerprint,
      claimedAt: new Date("2026-01-01T00:01:00.000Z"),
      staleBefore: new Date("2026-01-01T00:00:30.000Z"),
    });

    expect(reclaimed).toEqual({ kind: "new_claim" });
  });
});
