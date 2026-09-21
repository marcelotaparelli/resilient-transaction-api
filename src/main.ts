import { SQL } from "bun";
import { CreateTransaction } from "./application/use-cases/create-transaction";
import { GetTransaction } from "./application/use-cases/get-transaction";
import { ListTransactions } from "./application/use-cases/list-transactions";
import { createHttpHandler, startServer } from "./http/server";
import { HttpPaymentProvider } from "./infrastructure/providers/http-payment-provider";
import { InMemoryRateLimiter } from "./infrastructure/rate-limit/in-memory-rate-limiter";
import { PostgresTransactionRepository } from "./infrastructure/repositories/postgres-transaction-repository";

const databaseUrl = Bun.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required");
}

const processingTimeoutMs = Number(
  Bun.env.IDEMPOTENCY_PROCESSING_TIMEOUT_MS ?? "30000",
);
if (!Number.isSafeInteger(processingTimeoutMs) || processingTimeoutMs <= 0) {
  throw new Error("IDEMPOTENCY_PROCESSING_TIMEOUT_MS must be a positive integer");
}

const sql = new SQL(databaseUrl);
const transactionRepository = new PostgresTransactionRepository(sql);
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
  processingTimeoutMs,
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
