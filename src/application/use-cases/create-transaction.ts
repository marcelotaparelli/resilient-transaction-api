import type {
  TransactionInput,
  Transaction,
} from "../../domain/transaction";
import { IdempotencyConflictError } from "../errors/idempotency-conflict-error";
import { IdempotencyInProgressError } from "../errors/idempotency-in-progress-error";
import {
  ProviderCircuitOpenError,
  ProviderRejectedError,
} from "../errors/provider-errors";
import {
  createRequestFingerprint,
  normalizeTransactionInput,
} from "../idempotency/request-fingerprint";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type {
  PaymentProvider,
  ProviderResult,
} from "../ports/payment-provider";
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
    private readonly processingTimeoutMs: number,
  ) {}

  async execute(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<CreateTransactionResult> {
    const normalizedTransaction = normalizeTransactionInput(transaction);
    const requestFingerprint = await createRequestFingerprint(
      normalizedTransaction,
    );
    const claimedAt = this.clock.now();
    const claim = await this.transactionRepository.claimIdempotencyOperation({
      idempotencyKey,
      requestFingerprint,
      claimedAt,
      staleBefore: new Date(claimedAt.getTime() - this.processingTimeoutMs),
    });

    if (claim.kind === "completed_replay") {
      return { transaction: claim.transaction, created: false };
    }

    if (claim.kind === "fingerprint_conflict") {
      throw new IdempotencyConflictError();
    }

    if (claim.kind === "processing") {
      throw new IdempotencyInProgressError();
    }

    let providerResult: ProviderResult;
    try {
      providerResult = await this.paymentProvider.process(
        normalizedTransaction,
        idempotencyKey,
      );
    } catch (error: unknown) {
      if (
        error instanceof ProviderRejectedError ||
        error instanceof ProviderCircuitOpenError
      ) {
        await this.transactionRepository.releaseIdempotencyOperation({
          idempotencyKey,
          requestFingerprint,
        });
      }

      throw error;
    }

    const result: Transaction = {
      id: this.idGenerator.generate(),
      ...normalizedTransaction,
      status: providerResult.decision,
      providerTransactionId: providerResult.providerTransactionId,
      createdAt: this.clock.now(),
    };

    await this.transactionRepository.completeIdempotencyOperation({
      idempotencyKey,
      requestFingerprint,
      transaction: result,
      completedAt: this.clock.now(),
    });

    return { transaction: result, created: true };
  }
}
