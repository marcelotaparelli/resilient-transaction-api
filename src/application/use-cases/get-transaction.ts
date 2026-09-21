import type { Transaction } from "../../domain/transaction";
import { TransactionNotFoundError } from "../errors/transaction-not-found-error";
import type { TransactionRepository } from "../ports/transaction-repository";

export class GetTransaction {
  constructor(private readonly transactionRepository: TransactionRepository) {}

  async execute(transactionId: string): Promise<Transaction> {
    const transaction = await this.transactionRepository.findById(transactionId);

    if (transaction === null) {
      throw new TransactionNotFoundError();
    }

    return transaction;
  }
}
