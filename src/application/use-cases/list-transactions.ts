import type { Transaction } from "../../domain/transaction";
import type { TransactionRepository } from "../ports/transaction-repository";

type ListTransactionsResult = {
  data: Transaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export class ListTransactions {
  constructor(private readonly transactionRepository: TransactionRepository) {}

  async execute(page: number, limit: number): Promise<ListTransactionsResult> {
    const offset = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.transactionRepository.list(offset, limit),
      this.transactionRepository.count(),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
