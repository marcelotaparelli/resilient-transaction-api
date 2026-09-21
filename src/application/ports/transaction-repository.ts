import type { Transaction } from "../../domain/transaction";
import type {
  ClaimIdempotencyOperation,
  CompleteIdempotencyOperation,
  IdempotencyClaimResult,
  ReleaseIdempotencyOperation,
} from "../models/idempotency-operation";

export interface TransactionRepository {
  claimIdempotencyOperation(
    operation: ClaimIdempotencyOperation,
  ): Promise<IdempotencyClaimResult>;

  completeIdempotencyOperation(
    operation: CompleteIdempotencyOperation,
  ): Promise<void>;

  releaseIdempotencyOperation(
    operation: ReleaseIdempotencyOperation,
  ): Promise<void>;

  findById(transactionId: string): Promise<Transaction | null>;

  list(offset: number, limit: number): Promise<Transaction[]>;

  count(): Promise<number>;
}
