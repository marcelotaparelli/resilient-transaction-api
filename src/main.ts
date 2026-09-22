import { SQL } from "bun";
import { CreateTransaction } from "./application/use-cases/create-transaction";
import { GetTransaction } from "./application/use-cases/get-transaction";
import { ListTransactions } from "./application/use-cases/list-transactions";
import { loadConfig } from "./config";
import { createHttpHandler, startServer } from "./http/server";
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
import { JsonLogger } from "./infrastructure/observability/logger";
import { ApplicationMetrics } from "./infrastructure/observability/metrics";
import { currentRequestId } from "./infrastructure/observability/request-context";
import {
  ObservedRateLimiter,
  ObservedTransactionCache,
} from "./infrastructure/observability/observed-adapters";
import {
  GracefulShutdownCoordinator,
  InFlightRequestTracker,
  registerShutdownSignals,
} from "./infrastructure/operability/lifecycle";
import { ReadinessService } from "./infrastructure/operability/readiness";

const config = loadConfig(Bun.env);
const clock = { now: () => new Date() };
const logger = new JsonLogger();
const metrics = new ApplicationMetrics();
const requestTracker = new InFlightRequestTracker();
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
  const metricOperation =
    operation === "transaction_cache_read"
      ? "cache_get"
      : operation === "transaction_cache_write"
        ? "cache_set"
        : "rate_limit";
  metrics.redisError(metricOperation);
  logger.log("warn", "redis.error", {
    operation: metricOperation,
    requestId: currentRequestId(),
  });
};
const transactionRepository = new PostgresTransactionRepository(sql);
const transactionCache = new ObservedTransactionCache(
  new RedisTransactionCache(
    redis,
    config.transactionCacheKeyPrefix,
    config.transactionCacheTtlSeconds,
    reportRedisFailure,
  ),
  metrics,
  logger,
);
const httpPaymentProvider = new HttpPaymentProvider(
  config.providerUrl,
  config.retry.attemptTimeoutMs,
  undefined,
  undefined,
  metrics,
);
const circuitBreaker = new CircuitBreaker(config.breaker, clock, {
  opened: () => {
    metrics.circuitOpened();
    logger.log("warn", "circuit_breaker.opened", {
      requestId: currentRequestId(),
    });
  },
  closed: () =>
    logger.log("info", "circuit_breaker.closed", {
      requestId: currentRequestId(),
    }),
});
const paymentProvider = new ResilientPaymentProvider(
  httpPaymentProvider,
  new RetryPolicy(config.retry),
  circuitBreaker,
  { sleep: (delayMs) => Bun.sleep(delayMs) },
  { next: () => Math.random() },
  metrics,
  logger,
);
const rateLimiter = new ObservedRateLimiter(
  new RedisRateLimiter(
    redis,
    config.rateLimitMaxRequests,
    config.rateLimitWindowMs,
    config.rateLimitKeyPrefix,
    reportRedisFailure,
  ),
  metrics,
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
const readiness = new ReadinessService(
  async () => {
    await sql`SELECT 1`;
  },
  async () => {
    await redis.execute(() => redisClient.send("PING", []));
  },
  config.readinessTimeoutMs,
  () => requestTracker.isShuttingDown(),
  metrics,
  logger,
);

const startupReadiness = await readiness.check();
if (startupReadiness.status === "not_ready") {
  logger.log("error", "startup.failed", { operation: "postgres_readiness" });
  redisClient.close();
  await sql.close();
  throw new Error("Critical startup dependency is unavailable");
}

const handler = createHttpHandler({
  authenticator: new Sha256ServiceAuthenticator(config.serviceCredentials),
  maxBodyBytes: config.httpMaxBodyBytes,
  createTransaction,
  getTransaction,
  listTransactions,
  rateLimiter,
  logger,
  metrics,
  readiness,
  requestTracker,
});

const server = startServer(handler);
logger.log("info", "startup.ready", { state: startupReadiness.status });

const shutdown = new GracefulShutdownCoordinator(
  requestTracker,
  {
    stopHttp: (force) => server.stop(force),
    closeRedis: () => redisClient.close(),
    closePostgres: () => sql.close(),
  },
  config.shutdownGracePeriodMs,
  logger,
);

registerShutdownSignals(process, {
  shutdown: async (signal) => {
    await shutdown.shutdown(signal);
    process.exitCode = 0;
  },
});
