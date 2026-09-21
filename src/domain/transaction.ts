export type TransactionInput = {
  /** Integer amount in the currency's minor unit (for example, 1099 = BRL 10.99). */
  amount: number;
  currency: string;
  description: string;
};

export type TransactionStatus = "approved";

export type Transaction = TransactionInput & {
  id: string;
  providerTransactionId: string;
  status: TransactionStatus;
  createdAt: Date;
};
