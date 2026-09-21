import type {
  ClaimIdempotencyOperation,
  CompleteIdempotencyOperation,
  IdempotencyClaimResult,
  IdempotencyOperation,
  ReleaseIdempotencyOperation,
} from "../../application/models/idempotency-operation";
import type { TransactionRepository } from "../../application/ports/transaction-repository";
import type { Transaction } from "../../domain/transaction";

export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly transactionsById = new Map<string, Transaction>();
  private readonly operations = new Map<string, IdempotencyOperation>();

  async claimIdempotencyOperation(
    operation: ClaimIdempotencyOperation,
  ): Promise<IdempotencyClaimResult> {
    const existing = this.operations.get(operation.idempotencyKey);

    if (existing === undefined) {
      this.operations.set(operation.idempotencyKey, {
        idempotencyKey: operation.idempotencyKey,
        requestFingerprint: operation.requestFingerprint,
        status: "processing",
        transactionId: null,
        createdAt: operation.claimedAt,
        updatedAt: operation.claimedAt,
      });
      return { kind: "new_claim" };
    }

    if (existing.requestFingerprint !== operation.requestFingerprint) {
      return { kind: "fingerprint_conflict" };
    }

    if (existing.status === "completed" && existing.transactionId !== null) {
      const transaction = this.transactionsById.get(existing.transactionId);
      if (transaction === undefined) {
        throw new Error("Completed idempotency operation has no transaction");
      }

      return { kind: "completed_replay", transaction };
    }

    if (existing.updatedAt <= operation.staleBefore) {
      existing.updatedAt = operation.claimedAt;
      return { kind: "new_claim" };
    }

    return { kind: "processing" };
  }

  async completeIdempotencyOperation(
    operation: CompleteIdempotencyOperation,
  ): Promise<void> {
    const existing = this.operations.get(operation.idempotencyKey);
    if (
      existing === undefined ||
      existing.status !== "processing" ||
      existing.requestFingerprint !== operation.requestFingerprint
    ) {
      throw new Error("Idempotency operation cannot be completed");
    }

    this.transactionsById.set(operation.transaction.id, operation.transaction);
    existing.status = "completed";
    existing.transactionId = operation.transaction.id;
    existing.updatedAt = operation.completedAt;
  }

  async releaseIdempotencyOperation(
    operation: ReleaseIdempotencyOperation,
  ): Promise<void> {
    const existing = this.operations.get(operation.idempotencyKey);
    if (
      existing?.status === "processing" &&
      existing.requestFingerprint === operation.requestFingerprint
    ) {
      this.operations.delete(operation.idempotencyKey);
    }
  }

  async findById(transactionId: string): Promise<Transaction | null> {
    return this.transactionsById.get(transactionId) ?? null;
  }

  async list(offset: number, limit: number): Promise<Transaction[]> {
    return [...this.transactionsById.values()]
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(offset, offset + limit);
  }

  async count(): Promise<number> {
    return this.transactionsById.size;
  }
}
