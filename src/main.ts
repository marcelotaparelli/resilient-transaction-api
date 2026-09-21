import { CreateTransaction } from "./application/use-cases/create-transaction";
import { GetTransaction } from "./application/use-cases/get-transaction";
import { ListTransactions } from "./application/use-cases/list-transactions";
import { createHttpHandler, startServer } from "./http/server";
import { HttpPaymentProvider } from "./infrastructure/providers/http-payment-provider";
import { InMemoryRateLimiter } from "./infrastructure/rate-limit/in-memory-rate-limiter";
import { InMemoryTransactionRepository } from "./infrastructure/repositories/in-memory-transaction-repository";

const transactionRepository = new InMemoryTransactionRepository();
const paymentProvider = new HttpPaymentProvider(
  "http://localhost:4003/transactions",
  3_000,
  3,
  500,
);
const rateLimiter = new InMemoryRateLimiter(5, 60_000);

const createTransaction = new CreateTransaction(
  transactionRepository,
  paymentProvider,
  { generate: () => crypto.randomUUID() },
  { now: () => new Date() },
);
const getTransaction = new GetTransaction(transactionRepository);
const listTransactions = new ListTransactions(transactionRepository);

const handler = createHttpHandler({
  createTransaction,
  getTransaction,
  listTransactions,
  rateLimiter,
});

startServer(handler);
