import { SQL } from "bun";
import { CreateTransaction } from "./application/use-cases/create-transaction";
import { GetTransaction } from "./application/use-cases/get-transaction";
import { ListTransactions } from "./application/use-cases/list-transactions";
import { loadConfig } from "./config";
import { createHttpHandler, startServer } from "./http/server";
import { CircuitBreaker } from "./infrastructure/providers/circuit-breaker";
import { HttpPaymentProvider } from "./infrastructure/providers/http-payment-provider";
import { ResilientPaymentProvider } from "./infrastructure/providers/resilient-payment-provider";
import { RetryPolicy } from "./infrastructure/providers/retry-policy";
import { InMemoryRateLimiter } from "./infrastructure/rate-limit/in-memory-rate-limiter";
import { PostgresTransactionRepository } from "./infrastructure/repositories/postgres-transaction-repository";

const config = loadConfig(Bun.env);
const clock = { now: () => new Date() };
const sql = new SQL(config.databaseUrl);
const transactionRepository = new PostgresTransactionRepository(sql);
const httpPaymentProvider = new HttpPaymentProvider(
  config.providerUrl,
  config.retry.attemptTimeoutMs,
);
const paymentProvider = new ResilientPaymentProvider(
  httpPaymentProvider,
  new RetryPolicy(config.retry),
  new CircuitBreaker(config.breaker, clock),
  { sleep: (delayMs) => Bun.sleep(delayMs) },
  { next: () => Math.random() },
);
const rateLimiter = new InMemoryRateLimiter(5, 60_000);

const createTransaction = new CreateTransaction(
  transactionRepository,
  paymentProvider,
  { generate: () => crypto.randomUUID() },
  clock,
  config.processingStaleTimeoutMs,
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
