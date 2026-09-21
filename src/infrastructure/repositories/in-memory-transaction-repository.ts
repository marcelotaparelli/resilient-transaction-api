import type { TransactionRepository } from "../../application/ports/transaction-repository";
import type { Transaction } from "../../domain/transaction";

export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly transactionsById = new Map<string, Transaction>();
  private readonly transactionsByIdempotencyKey = new Map<string, Transaction>();

  async findById(transactionId: string): Promise<Transaction | null> {
    return this.transactionsById.get(transactionId) ?? null;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    return this.transactionsByIdempotencyKey.get(idempotencyKey) ?? null;
  }

  async save(
    idempotencyKey: string,
    transaction: Transaction,
  ): Promise<void> {
    const previous = this.transactionsByIdempotencyKey.get(idempotencyKey);
    if (previous !== undefined && previous.id !== transaction.id) {
      this.transactionsById.delete(previous.id);
    }

    this.transactionsById.set(transaction.id, transaction);
    this.transactionsByIdempotencyKey.set(idempotencyKey, transaction);
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
