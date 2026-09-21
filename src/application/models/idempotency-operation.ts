import type { Transaction } from "../../domain/transaction";

export type IdempotencyOperationStatus = "processing" | "completed";

export type IdempotencyOperation = {
  idempotencyKey: string;
  requestFingerprint: string;
  status: IdempotencyOperationStatus;
  transactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimIdempotencyOperation = {
  idempotencyKey: string;
  requestFingerprint: string;
  claimedAt: Date;
  staleBefore: Date;
};

export type CompleteIdempotencyOperation = {
  idempotencyKey: string;
  requestFingerprint: string;
  transaction: Transaction;
  completedAt: Date;
};

export type ReleaseIdempotencyOperation = {
  idempotencyKey: string;
  requestFingerprint: string;
};

export type IdempotencyClaimResult =
  | { kind: "new_claim" }
  | { kind: "completed_replay"; transaction: Transaction }
  | { kind: "fingerprint_conflict" }
  | { kind: "processing" };
