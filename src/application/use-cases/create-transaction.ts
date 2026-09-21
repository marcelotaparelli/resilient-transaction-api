import type {
  TransactionInput,
  Transaction,
} from "../../domain/transaction";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { PaymentProvider } from "../ports/payment-provider";
import type { TransactionRepository } from "../ports/transaction-repository";

export type CreateTransactionResult = {
  transaction: Transaction;
  created: boolean;
};

export class CreateTransaction {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<CreateTransactionResult> {
    const previous =
      await this.transactionRepository.findByIdempotencyKey(idempotencyKey);

    if (previous !== null) {
      return { transaction: previous, created: false };
    }

    const providerResult = await this.paymentProvider.process(
      transaction,
      idempotencyKey,
    );

    const result: Transaction = {
      id: this.idGenerator.generate(),
      ...transaction,
      status: providerResult.decision,
      providerTransactionId: providerResult.providerTransactionId,
      createdAt: this.clock.now(),
    };

    await this.transactionRepository.save(idempotencyKey, result);

    return { transaction: result, created: true };
  }
}
