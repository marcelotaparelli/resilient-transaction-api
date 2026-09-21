import type { Transaction } from "../../domain/transaction";
import { TransactionNotFoundError } from "../errors/transaction-not-found-error";
import type { TransactionRepository } from "../ports/transaction-repository";
import type { TransactionCache } from "../ports/transaction-cache";

export class GetTransaction {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly transactionCache?: TransactionCache,
  ) {}

  async execute(transactionId: string): Promise<Transaction> {
    if (this.transactionCache !== undefined) {
      try {
        const cached = await this.transactionCache.get(transactionId);
        if (cached !== null) {
          return cached;
        }
      } catch {
        // Cache is an optimization. PostgreSQL remains the source of truth.
      }
    }

    const transaction = await this.transactionRepository.findById(transactionId);

    if (transaction === null) {
      throw new TransactionNotFoundError();
    }

    if (this.transactionCache !== undefined) {
      try {
        await this.transactionCache.set(transaction);
      } catch {
        // A cache write cannot invalidate a successful PostgreSQL read.
      }
    }

    return transaction;
  }
}
