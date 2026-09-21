import type { TransactionInput } from "../../domain/transaction";

export function normalizeTransactionInput(
  transaction: TransactionInput,
): TransactionInput {
  return {
    amount: transaction.amount,
    currency: transaction.currency.trim().toUpperCase(),
    description: transaction.description.trim(),
  };
}

export async function createRequestFingerprint(
  transaction: TransactionInput,
): Promise<string> {
  const normalized = normalizeTransactionInput(transaction);
  const canonical = JSON.stringify({
    amount: normalized.amount,
    currency: normalized.currency,
    description: normalized.description,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );

  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
