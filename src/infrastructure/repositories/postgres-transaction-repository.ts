import type {
  ClaimIdempotencyOperation,
  CompleteIdempotencyOperation,
  IdempotencyClaimResult,
  ReleaseIdempotencyOperation,
} from "../../application/models/idempotency-operation";
import type { TransactionRepository } from "../../application/ports/transaction-repository";
import type { Transaction } from "../../domain/transaction";
import type { SQL } from "bun";

type TransactionRow = {
  id: string;
  amount: number | string;
  currency: string;
  description: string;
  provider_transaction_id: string;
  status: "approved";
  created_at: Date | string;
};

type OperationRow = {
  request_fingerprint: string;
  operation_status: "processing" | "completed";
  transaction_id: string | null;
  id: string | null;
  amount: number | string | null;
  currency: string | null;
  description: string | null;
  provider_transaction_id: string | null;
  transaction_status: "approved" | null;
  transaction_created_at: Date | string | null;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toSafeNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database returned an unsafe transaction amount");
  }

  return parsed;
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    amount: toSafeNumber(row.amount),
    currency: row.currency,
    description: row.description,
    providerTransactionId: row.provider_transaction_id,
    status: row.status,
    createdAt: toDate(row.created_at),
  };
}

function mapCompletedOperation(row: OperationRow): Transaction {
  if (
    row.id === null ||
    row.amount === null ||
    row.currency === null ||
    row.description === null ||
    row.provider_transaction_id === null ||
    row.transaction_status === null ||
    row.transaction_created_at === null
  ) {
    throw new Error("Completed idempotency operation has no transaction");
  }

  return mapTransaction({
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    provider_transaction_id: row.provider_transaction_id,
    status: row.transaction_status,
    created_at: row.transaction_created_at,
  });
}

export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private readonly sql: SQL) {}

  async claimIdempotencyOperation(
    operation: ClaimIdempotencyOperation,
  ): Promise<IdempotencyClaimResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.sql<{ idempotency_key: string }[]>`
        INSERT INTO idempotency_operations (
          idempotency_key,
          request_fingerprint,
          status,
          transaction_id,
          created_at,
          updated_at
        )
        VALUES (
          ${operation.idempotencyKey},
          ${operation.requestFingerprint},
          'processing',
          NULL,
          ${operation.claimedAt},
          ${operation.claimedAt}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `;

      if (inserted.length === 1) {
        return { kind: "new_claim" };
      }

      const reclaimed = await this.sql<{ idempotency_key: string }[]>`
        UPDATE idempotency_operations
        SET updated_at = ${operation.claimedAt}
        WHERE idempotency_key = ${operation.idempotencyKey}
          AND request_fingerprint = ${operation.requestFingerprint}
          AND status = 'processing'
          AND updated_at <= ${operation.staleBefore}
        RETURNING idempotency_key
      `;

      if (reclaimed.length === 1) {
        return { kind: "new_claim" };
      }

      const rows = await this.sql<OperationRow[]>`
        SELECT
          operation.request_fingerprint,
          operation.status AS operation_status,
          operation.transaction_id,
          result.id,
          result.amount,
          result.currency,
          result.description,
          result.provider_transaction_id,
          result.status AS transaction_status,
          result.created_at AS transaction_created_at
        FROM idempotency_operations AS operation
        LEFT JOIN transactions AS result
          ON result.id = operation.transaction_id
        WHERE operation.idempotency_key = ${operation.idempotencyKey}
      `;
      const row = rows[0];

      if (row === undefined) {
        continue;
      }

      if (row.request_fingerprint !== operation.requestFingerprint) {
        return { kind: "fingerprint_conflict" };
      }

      if (row.operation_status === "completed") {
        return {
          kind: "completed_replay",
          transaction: mapCompletedOperation(row),
        };
      }

      return { kind: "processing" };
    }

    throw new Error("Idempotency operation changed during claim");
  }

  async completeIdempotencyOperation(
    operation: CompleteIdempotencyOperation,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const result = operation.transaction;
      await transaction`
        INSERT INTO transactions (
          id,
          amount,
          currency,
          description,
          provider_transaction_id,
          status,
          created_at
        )
        VALUES (
          ${result.id},
          ${result.amount},
          ${result.currency},
          ${result.description},
          ${result.providerTransactionId},
          ${result.status},
          ${result.createdAt}
        )
      `;

      const completed = await transaction<{ idempotency_key: string }[]>`
        UPDATE idempotency_operations
        SET
          status = 'completed',
          transaction_id = ${result.id},
          updated_at = ${operation.completedAt}
        WHERE idempotency_key = ${operation.idempotencyKey}
          AND request_fingerprint = ${operation.requestFingerprint}
          AND status = 'processing'
        RETURNING idempotency_key
      `;

      if (completed.length !== 1) {
        throw new Error("Idempotency operation cannot be completed");
      }
    });
  }

  async releaseIdempotencyOperation(
    operation: ReleaseIdempotencyOperation,
  ): Promise<void> {
    await this.sql`
      DELETE FROM idempotency_operations
      WHERE idempotency_key = ${operation.idempotencyKey}
        AND request_fingerprint = ${operation.requestFingerprint}
        AND status = 'processing'
    `;
  }

  async findById(transactionId: string): Promise<Transaction | null> {
    const rows = await this.sql<TransactionRow[]>`
      SELECT
        id,
        amount,
        currency,
        description,
        provider_transaction_id,
        status,
        created_at
      FROM transactions
      WHERE id = ${transactionId}
    `;

    return rows[0] === undefined ? null : mapTransaction(rows[0]);
  }

  async list(offset: number, limit: number): Promise<Transaction[]> {
    const rows = await this.sql<TransactionRow[]>`
      SELECT
        id,
        amount,
        currency,
        description,
        provider_transaction_id,
        status,
        created_at
      FROM transactions
      ORDER BY created_at DESC, id DESC
      OFFSET ${offset}
      LIMIT ${limit}
    `;

    return rows.map(mapTransaction);
  }

  async count(): Promise<number> {
    const rows = await this.sql<{ total: number | string }[]>`
      SELECT COUNT(*) AS total
      FROM transactions
    `;
    const total = rows[0]?.total;

    if (total === undefined) {
      throw new Error("Database did not return a transaction count");
    }

    return toSafeNumber(total);
  }
}
