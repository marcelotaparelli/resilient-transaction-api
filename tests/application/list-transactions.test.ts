import { describe, expect, test } from "bun:test";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
import { ListTransactions } from "../../src/application/use-cases/list-transactions";
import type { Transaction } from "../../src/domain/transaction";

class RepositorySpy implements TransactionRepository {
  offset: number | null = null;
  limit: number | null = null;

  async findById(): Promise<Transaction | null> {
    return null;
  }

  async findByIdempotencyKey(): Promise<Transaction | null> {
    return null;
  }

  async save(): Promise<void> {}

  async list(offset: number, limit: number): Promise<Transaction[]> {
    this.offset = offset;
    this.limit = limit;
    return [];
  }

  async count(): Promise<number> {
    return 45;
  }
}

describe("ListTransactions", () => {
  test("calculates offset, total and total pages", async () => {
    const repository = new RepositorySpy();
    const useCase = new ListTransactions(repository);

    const result = await useCase.execute(3, 20);

    expect(repository.offset).toBe(40);
    expect(repository.limit).toBe(20);
    expect(result.pagination).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });
});
