import type { Transaction } from "../../domain/transaction";

export interface TransactionCache {
  get(transactionId: string): Promise<Transaction | null>;
  set(transaction: Transaction): Promise<void>;
}
