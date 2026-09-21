import { SQL } from "bun";
import { CreateTransaction } from "./application/use-cases/create-transaction";
import { GetTransaction } from "./application/use-cases/get-transaction";
import { ListTransactions } from "./application/use-cases/list-transactions";
import { loadConfig } from "./config";
import { createHttpHandler, startServer } from "./http/server";
import { redactSensitiveLogFields } from "./http/security/log-redaction";
import { Sha256ServiceAuthenticator } from "./http/security/service-authenticator";
import { RedisTransactionCache } from "./infrastructure/cache/redis-transaction-cache";
import { CircuitBreaker } from "./infrastructure/providers/circuit-breaker";
import { HttpPaymentProvider } from "./infrastructure/providers/http-payment-provider";
import { ResilientPaymentProvider } from "./infrastructure/providers/resilient-payment-provider";
import { RetryPolicy } from "./infrastructure/providers/retry-policy";
import { RedisRateLimiter } from "./infrastructure/rate-limit/redis-rate-limiter";
import {
  createBunRedisClient,
  RedisCommandExecutor,
} from "./infrastructure/redis/redis-client";
import { PostgresTransactionRepository } from "./infrastructure/repositories/postgres-transaction-repository";

const config = loadConfig(Bun.env);
const clock = { now: () => new Date() };
const sql = new SQL(config.databaseUrl);
const redisClient = createBunRedisClient(
  config.redisUrl,
  config.redisCommandTimeoutMs,
);
const redis = new RedisCommandExecutor(
  redisClient,
  config.redisCommandTimeoutMs,
);
const reportRedisFailure = (operation: string): void => {
  console.warn(
    JSON.stringify(
      redactSensitiveLogFields({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "redis_operation_failed",
        operation,
      }),
    ),
  );
};
const transactionRepository = new PostgresTransactionRepository(sql);
const transactionCache = new RedisTransactionCache(
  redis,
  config.transactionCacheKeyPrefix,
  config.transactionCacheTtlSeconds,
  reportRedisFailure,
);
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
const rateLimiter = new RedisRateLimiter(
  redis,
  config.rateLimitMaxRequests,
  config.rateLimitWindowMs,
  config.rateLimitKeyPrefix,
  reportRedisFailure,
);

const createTransaction = new CreateTransaction(
  transactionRepository,
  paymentProvider,
  { generate: () => crypto.randomUUID() },
  clock,
  config.processingStaleTimeoutMs,
);
const getTransaction = new GetTransaction(
  transactionRepository,
  transactionCache,
);
const listTransactions = new ListTransactions(transactionRepository);

const handler = createHttpHandler({
  authenticator: new Sha256ServiceAuthenticator(config.serviceCredentials),
  maxBodyBytes: config.httpMaxBodyBytes,
  createTransaction,
  getTransaction,
  listTransactions,
  rateLimiter,
});

startServer(handler);
