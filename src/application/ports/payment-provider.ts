import type {
  TransactionInput,
} from "../../domain/transaction";

export type ProviderResult = {
  providerTransactionId: string;
  decision: "approved";
};

export interface PaymentProvider {
  process(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult>;
}
