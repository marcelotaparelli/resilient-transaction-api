import type { Transaction } from "../../domain/transaction";

export interface TransactionRepository {
  findById(transactionId: string): Promise<Transaction | null>;

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Transaction | null>;

  save(
    idempotencyKey: string,
    transaction: Transaction,
  ): Promise<void>;

  list(offset: number, limit: number): Promise<Transaction[]>;

  count(): Promise<number>;
}
