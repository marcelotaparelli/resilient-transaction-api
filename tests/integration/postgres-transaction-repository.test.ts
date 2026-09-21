import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { SQL } from "bun";
import { IdempotencyConflictError } from "../../src/application/errors/idempotency-conflict-error";
import { IdempotencyInProgressError } from "../../src/application/errors/idempotency-in-progress-error";
import {
  ProviderCircuitOpenError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
} from "../../src/application/errors/provider-errors";
import { createRequestFingerprint } from "../../src/application/idempotency/request-fingerprint";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../src/application/ports/payment-provider";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
import { CreateTransaction } from "../../src/application/use-cases/create-transaction";
import { GetTransaction } from "../../src/application/use-cases/get-transaction";
import { ListTransactions } from "../../src/application/use-cases/list-transactions";
import type { Transaction } from "../../src/domain/transaction";
import { createFakeProviderHandler } from "../../src/dev/fake-provider";
import { createHttpHandler } from "../../src/http/server";
import { RedisTransactionCache } from "../../src/infrastructure/cache/redis-transaction-cache";
import { runMigrations } from "../../src/infrastructure/database/migrate";
import { CircuitBreaker } from "../../src/infrastructure/providers/circuit-breaker";
import {
  HttpPaymentProvider,
  type FetchRequest,
  type TimeoutScheduler,
} from "../../src/infrastructure/providers/http-payment-provider";
import { ResilientPaymentProvider } from "../../src/infrastructure/providers/resilient-payment-provider";
import { RetryPolicy } from "../../src/infrastructure/providers/retry-policy";
import { RedisRateLimiter } from "../../src/infrastructure/rate-limit/redis-rate-limiter";
import {
  createBunRedisClient,
  RedisCommandExecutor,
} from "../../src/infrastructure/redis/redis-client";
import { transactionCacheKey } from "../../src/infrastructure/redis/redis-keys";
import { PostgresTransactionRepository } from "../../src/infrastructure/repositories/postgres-transaction-repository";

const databaseUrl = Bun.env.TEST_DATABASE_URL;
const redisUrl = Bun.env.TEST_REDIS_URL;
const describeWithPostgres =
  databaseUrl === undefined ? describe.skip : describe;
const testWithRedis = redisUrl === undefined ? test.skip : test;
const fingerprint = "a".repeat(64);
const baseTime = new Date("2026-01-01T00:00:00.000Z");

function transaction(
  id: string,
  createdAt = baseTime,
  description = "Order 123",
): Transaction {
  return {
    id,
    amount: 1099,
    currency: "BRL",
    description,
    status: "approved",
    providerTransactionId: `provider-${id}`,
    createdAt,
  };
}

class ControlledProvider implements PaymentProvider {
  calls = 0;
  keys: string[] = [];
  error: Error | null = null;
  delayMs = 0;
  result: ProviderResult = {
    providerTransactionId: "provider-result-1",
    decision: "approved",
  };

  async process(
    _transaction: Parameters<PaymentProvider["process"]>[0],
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    this.calls += 1;
    this.keys.push(idempotencyKey);
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    if (this.error !== null) {
      throw this.error;
    }

    return this.result;
  }
}

function resilientFakeProvider(
  outcomes: Parameters<typeof createFakeProviderHandler>[0]["outcomes"],
  failureThreshold = 10,
): {
  provider: PaymentProvider;
  breaker: CircuitBreaker;
  keys: string[];
} {
  const handler = createFakeProviderHandler({ outcomes });
  const keys: string[] = [];
  const fetchRequest: FetchRequest = async (input, init) => {
    const request = new Request(input, init);
    keys.push(request.headers.get("Idempotency-Key") ?? "");
    return handler(request);
  };
  const breaker = new CircuitBreaker(
    { failureThreshold, openDurationMs: 1_000 },
    { now: () => baseTime },
  );
  return {
    provider: new ResilientPaymentProvider(
      new HttpPaymentProvider("http://provider/transactions", 3_000, fetchRequest),
      new RetryPolicy({
        maxAttempts: 3,
        attemptTimeoutMs: 3_000,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
        jitterRatio: 0.2,
      }),
      breaker,
      { sleep: async () => undefined },
      { next: () => 0 },
    ),
    breaker,
    keys,
  };
}

describeWithPostgres("PostgresTransactionRepository", () => {
  let sql: SQL;
  let repository: PostgresTransactionRepository;

  beforeAll(async () => {
    sql = new SQL(databaseUrl as string, { max: 20 });
    await sql.unsafe(
      "DROP TABLE IF EXISTS idempotency_operations, transactions, schema_migrations CASCADE",
    );
    await runMigrations(sql);
    repository = new PostgresTransactionRepository(sql);
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE idempotency_operations, transactions`;
  });

  afterAll(async () => {
    await sql.close();
  });

  test("applies versioned migrations from an empty database and is idempotent", async () => {
    await runMigrations(sql);
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'transactions',
          'idempotency_operations',
          'schema_migrations'
        )
      ORDER BY table_name
    `;
    const migrations = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const uniqueKey = await sql<{ constraint_type: string }[]>`
      SELECT constraint_type
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'idempotency_operations'
        AND constraint_name = 'idempotency_operations_pkey'
    `;

    expect(tables.map((row) => row.table_name)).toEqual([
      "idempotency_operations",
      "schema_migrations",
      "transactions",
    ]);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.version).toBe(
      "001_create_transactions_and_idempotency_operations.sql",
    );
    expect(uniqueKey[0]?.constraint_type).toBe("PRIMARY KEY");
  });

  test("persists a transaction and returns a completed replay", async () => {
    const result = transaction("00000000-0000-4000-8000-000000000001");
    expect(
      await repository.claimIdempotencyOperation({
        idempotencyKey: "replay-key",
        requestFingerprint: fingerprint,
        claimedAt: baseTime,
        staleBefore: new Date(baseTime.getTime() - 30_000),
      }),
    ).toEqual({ kind: "new_claim" });

    await repository.completeIdempotencyOperation({
      idempotencyKey: "replay-key",
      requestFingerprint: fingerprint,
      transaction: result,
      completedAt: baseTime,
    });

    expect(await repository.findById(result.id)).toEqual(result);
    expect(
      await repository.claimIdempotencyOperation({
        idempotencyKey: "replay-key",
        requestFingerprint: fingerprint,
        claimedAt: new Date(baseTime.getTime() + 1_000),
        staleBefore: new Date(baseTime.getTime() - 29_000),
      }),
    ).toEqual({ kind: "completed_replay", transaction: result });
  });

  test("returns fingerprint conflict and never reuses the prior result", async () => {
    await repository.claimIdempotencyOperation({
      idempotencyKey: "conflict-key",
      requestFingerprint: fingerprint,
      claimedAt: baseTime,
      staleBefore: new Date(baseTime.getTime() - 30_000),
    });

    expect(
      await repository.claimIdempotencyOperation({
        idempotencyKey: "conflict-key",
        requestFingerprint: "b".repeat(64),
        claimedAt: new Date(baseTime.getTime() + 1_000),
        staleBefore: new Date(baseTime.getTime() - 29_000),
      }),
    ).toEqual({ kind: "fingerprint_conflict" });
  });

  test("same key with a different payload raises conflict without another provider call", async () => {
    const provider = new ControlledProvider();
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000005" },
      { now: () => baseTime },
      30_000,
    );
    const first = await useCase.execute(
      { amount: 1099, currency: "BRL", description: "Original" },
      "payload-conflict-key",
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Changed" },
        "payload-conflict-key",
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(first.created).toBeTrue();
    expect(provider.calls).toBe(1);
    expect(await repository.count()).toBe(1);
  });

  test("uses the UNIQUE key to allow exactly one new claim under 20 concurrent attempts", async () => {
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.claimIdempotencyOperation({
          idempotencyKey: "concurrent-claim-key",
          requestFingerprint: fingerprint,
          claimedAt: baseTime,
          staleBefore: new Date(baseTime.getTime() - 30_000),
        }),
      ),
    );
    const operationCount = await sql<{ total: number | string }[]>`
      SELECT COUNT(*) AS total
      FROM idempotency_operations
      WHERE idempotency_key = 'concurrent-claim-key'
    `;

    expect(claims.filter((claim) => claim.kind === "new_claim")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "processing")).toHaveLength(19);
    expect(Number(operationCount[0]?.total)).toBe(1);
  });

  test("allows only one provider call during concurrent CreateTransaction executions", async () => {
    const provider = new ControlledProvider();
    provider.delayMs = 150;
    let generatedId = 0;
    const useCase = new CreateTransaction(
      repository,
      provider,
      {
        generate: () => {
          generatedId += 1;
          return `00000000-0000-4000-8000-${String(generatedId).padStart(12, "0")}`;
        },
      },
      { now: () => baseTime },
      30_000,
    );

    const executions = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        useCase.execute(
          { amount: 1099, currency: "BRL", description: "Concurrent" },
          "concurrent-use-case-key",
        ),
      ),
    );
    const fulfilled = executions.filter((result) => result.status === "fulfilled");
    const rejected = executions.filter((result) => result.status === "rejected");

    expect(provider.calls).toBe(1);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    expect(
      rejected.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof IdempotencyInProgressError,
      ),
    ).toBeTrue();
    expect(await repository.count()).toBe(1);
  });

  test("does not call the provider when another operation is already processing", async () => {
    await repository.claimIdempotencyOperation({
      idempotencyKey: "already-processing-key",
      requestFingerprint:
        "a2e97cad2002b1babda12974e1821c08b3e416573a9bdcb33b74b6b4852ae10f",
      claimedAt: baseTime,
      staleBefore: new Date(baseTime.getTime() - 30_000),
    });
    const provider = new ControlledProvider();
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000010" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Order 123" },
        "already-processing-key",
      ),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
    expect(provider.calls).toBe(0);
    expect(await repository.count()).toBe(0);
  });

  test("a provider rejection releases the operation and creates no transaction", async () => {
    const provider = new ControlledProvider();
    provider.error = new ProviderRejectedError();
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000011" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Rejected" },
        "rejected-key",
      ),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
    const operations = await sql<{ total: number | string }[]>`
      SELECT COUNT(*) AS total FROM idempotency_operations
    `;

    expect(await repository.count()).toBe(0);
    expect(Number(operations[0]?.total)).toBe(0);
  });

  test("an ambiguous timeout keeps processing and can be reclaimed only after its lease", async () => {
    const timeoutFingerprint = await createRequestFingerprint({
      amount: 1099,
      currency: "BRL",
      description: "Timeout",
    });
    const provider = new ControlledProvider();
    provider.error = new ProviderTimeoutError();
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000012" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Timeout" },
        "timeout-key",
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(await repository.count()).toBe(0);

    const active = await repository.claimIdempotencyOperation({
      idempotencyKey: "timeout-key",
      requestFingerprint: timeoutFingerprint,
      claimedAt: new Date(baseTime.getTime() + 10_000),
      staleBefore: new Date(baseTime.getTime() - 20_000),
    });
    const reclaimed = await repository.claimIdempotencyOperation({
      idempotencyKey: "timeout-key",
      requestFingerprint: timeoutFingerprint,
      claimedAt: new Date(baseTime.getTime() + 31_000),
      staleBefore: new Date(baseTime.getTime() + 1_000),
    });

    expect(active).toEqual({ kind: "processing" });
    expect(reclaimed).toEqual({ kind: "new_claim" });
  });

  test("rolls back a failed completion and recovers by reclaiming with the same provider key", async () => {
    const occupiedId = "00000000-0000-4000-8000-000000000020";
    await repository.claimIdempotencyOperation({
      idempotencyKey: "occupied-key",
      requestFingerprint: fingerprint,
      claimedAt: baseTime,
      staleBefore: new Date(baseTime.getTime() - 30_000),
    });
    await repository.completeIdempotencyOperation({
      idempotencyKey: "occupied-key",
      requestFingerprint: fingerprint,
      transaction: transaction(occupiedId),
      completedAt: baseTime,
    });

    const provider = new ControlledProvider();
    const firstAttempt = new CreateTransaction(
      repository,
      provider,
      { generate: () => occupiedId },
      { now: () => new Date(baseTime.getTime() + 1_000) },
      30_000,
    );
    await expect(
      firstAttempt.execute(
        { amount: 1099, currency: "BRL", description: "Recovery" },
        "recovery-key",
      ),
    ).rejects.toBeDefined();
    expect(await repository.count()).toBe(1);

    const operationAfterFailure = await sql<
      { status: string; transaction_id: string | null }[]
    >`
      SELECT status, transaction_id
      FROM idempotency_operations
      WHERE idempotency_key = 'recovery-key'
    `;
    expect(operationAfterFailure[0]).toEqual({
      status: "processing",
      transaction_id: null,
    });

    const recovered = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000021" },
      { now: () => new Date(baseTime.getTime() + 32_000) },
      30_000,
    );
    const result = await recovered.execute(
      { amount: 1099, currency: "BRL", description: "Recovery" },
      "recovery-key",
    );

    expect(result.created).toBeTrue();
    expect(provider.keys).toEqual(["recovery-key", "recovery-key"]);
    expect(await repository.count()).toBe(2);
  });

  test("lists with stable created_at and id ordering and preserves pagination", async () => {
    const entries = [
      transaction(
        "00000000-0000-4000-8000-000000000031",
        new Date("2026-01-01T00:00:00.000Z"),
      ),
      transaction(
        "00000000-0000-4000-8000-000000000032",
        new Date("2026-01-02T00:00:00.000Z"),
      ),
      transaction(
        "00000000-0000-4000-8000-000000000033",
        new Date("2026-01-02T00:00:00.000Z"),
      ),
    ];
    for (const [index, entry] of entries.entries()) {
      const key = `list-key-${index}`;
      await repository.claimIdempotencyOperation({
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        claimedAt: entry.createdAt,
        staleBefore: new Date(entry.createdAt.getTime() - 30_000),
      });
      await repository.completeIdempotencyOperation({
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        transaction: entry,
        completedAt: entry.createdAt,
      });
    }

    expect((await repository.list(0, 2)).map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000033",
      "00000000-0000-4000-8000-000000000032",
    ]);
    expect((await repository.list(2, 2)).map((item) => item.id)).toEqual([
      "00000000-0000-4000-8000-000000000031",
    ]);
    expect(await repository.count()).toBe(3);
  });

  test("a new repository instance replays completed state from PostgreSQL", async () => {
    const result = transaction("00000000-0000-4000-8000-000000000040");
    await repository.claimIdempotencyOperation({
      idempotencyKey: "restart-key",
      requestFingerprint: fingerprint,
      claimedAt: baseTime,
      staleBefore: new Date(baseTime.getTime() - 30_000),
    });
    await repository.completeIdempotencyOperation({
      idempotencyKey: "restart-key",
      requestFingerprint: fingerprint,
      transaction: result,
      completedAt: baseTime,
    });

    const repositoryAfterRestart = new PostgresTransactionRepository(sql);
    expect(
      await repositoryAfterRestart.claimIdempotencyOperation({
        idempotencyKey: "restart-key",
        requestFingerprint: fingerprint,
        claimedAt: new Date(baseTime.getTime() + 1_000),
        staleBefore: new Date(baseTime.getTime() - 29_000),
      }),
    ).toEqual({ kind: "completed_replay", transaction: result });
  });

  test("completes PostgreSQL state after deterministic transient failures", async () => {
    const { provider, keys } = resilientFakeProvider([503, 503, "success"]);
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000050" },
      { now: () => baseTime },
      30_000,
    );

    const result = await useCase.execute(
      { amount: 1099, currency: "BRL", description: "Transient recovery" },
      "resilience-success-key",
    );

    expect(result.created).toBeTrue();
    expect(keys).toEqual([
      "resilience-success-key",
      "resilience-success-key",
      "resilience-success-key",
    ]);
    expect(await repository.count()).toBe(1);
    expect(await repository.findById(result.transaction.id)).toEqual(
      result.transaction,
    );
  });

  test("keeps processing after deterministic ambiguous retries are exhausted", async () => {
    const { provider, keys } = resilientFakeProvider([503, 503, 503]);
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000051" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Ambiguous failure" },
        "resilience-ambiguous-key",
      ),
    ).rejects.toBeInstanceOf(ProviderServerError);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM idempotency_operations
      WHERE idempotency_key = 'resilience-ambiguous-key'
    `;

    expect(keys).toEqual([
      "resilience-ambiguous-key",
      "resilience-ambiguous-key",
      "resilience-ambiguous-key",
    ]);
    expect(await repository.count()).toBe(0);
    expect(rows[0]?.status).toBe("processing");
  });

  test("aborts and retries hanging HTTP attempts while keeping PostgreSQL processing", async () => {
    const keys: string[] = [];
    const fetchRequest: FetchRequest = (input, init) => {
      const request = new Request(input, init);
      keys.push(request.headers.get("Idempotency-Key") ?? "");
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    };
    const immediateTimeout: TimeoutScheduler = {
      schedule: (callback) => {
        queueMicrotask(callback);
        return { cancel: () => undefined };
      },
    };
    const resilientProvider = new ResilientPaymentProvider(
      new HttpPaymentProvider(
        "http://provider/transactions",
        3_000,
        fetchRequest,
        immediateTimeout,
      ),
      new RetryPolicy({
        maxAttempts: 3,
        attemptTimeoutMs: 3_000,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
        jitterRatio: 0.2,
      }),
      new CircuitBreaker(
        { failureThreshold: 10, openDurationMs: 1_000 },
        { now: () => baseTime },
      ),
      { sleep: async () => undefined },
      { next: () => 0 },
    );
    const useCase = new CreateTransaction(
      repository,
      resilientProvider,
      { generate: () => "00000000-0000-4000-8000-000000000054" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Provider timeout" },
        "resilience-timeout-key",
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM idempotency_operations
      WHERE idempotency_key = 'resilience-timeout-key'
    `;

    expect(keys).toEqual([
      "resilience-timeout-key",
      "resilience-timeout-key",
      "resilience-timeout-key",
    ]);
    expect(await repository.count()).toBe(0);
    expect(rows[0]?.status).toBe("processing");
  });

  test("releases PostgreSQL claim after a deterministic definitive rejection", async () => {
    const { provider, keys } = resilientFakeProvider([400]);
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000052" },
      { now: () => baseTime },
      30_000,
    );

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Rejected request" },
        "resilience-rejected-key",
      ),
    ).rejects.toBeInstanceOf(ProviderRejectedError);
    const rows = await sql<{ total: number | string }[]>`
      SELECT COUNT(*) AS total FROM idempotency_operations
      WHERE idempotency_key = 'resilience-rejected-key'
    `;

    expect(keys).toEqual(["resilience-rejected-key"]);
    expect(await repository.count()).toBe(0);
    expect(Number(rows[0]?.total)).toBe(0);
  });

  test("releases a new claim when an open breaker blocks before any external call", async () => {
    const { provider, breaker, keys } = resilientFakeProvider(
      [503, 503, 503],
      1,
    );
    const useCase = new CreateTransaction(
      repository,
      provider,
      { generate: () => "00000000-0000-4000-8000-000000000053" },
      { now: () => baseTime },
      30_000,
    );
    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Open breaker seed" },
        "breaker-seed-key",
      ),
    ).rejects.toBeInstanceOf(ProviderServerError);
    expect(breaker.state()).toBe("open");

    await expect(
      useCase.execute(
        { amount: 1099, currency: "BRL", description: "Blocked before call" },
        "breaker-blocked-key",
      ),
    ).rejects.toBeInstanceOf(ProviderCircuitOpenError);
    const blockedRows = await sql<{ total: number | string }[]>`
      SELECT COUNT(*) AS total FROM idempotency_operations
      WHERE idempotency_key = 'breaker-blocked-key'
    `;

    expect(keys).toHaveLength(3);
    expect(Number(blockedRows[0]?.total)).toBe(0);
  });

  testWithRedis("serves POST then cache MISS and HIT through the HTTP handler", async () => {
    const redisClient = createBunRedisClient(redisUrl as string, 250);
    const redis = new RedisCommandExecutor(redisClient, 250);
    const cachePrefix = "transaction-cache:flow-test";
    const ratePrefix = "rate-limit:flow-test";
    const transactionId = "00000000-0000-4000-8000-000000000060";
    const cache = new RedisTransactionCache(redis, cachePrefix, 60);
    let findByIdCalls = 0;
    const trackingRepository: TransactionRepository = {
      claimIdempotencyOperation: (operation) =>
        repository.claimIdempotencyOperation(operation),
      completeIdempotencyOperation: (operation) =>
        repository.completeIdempotencyOperation(operation),
      releaseIdempotencyOperation: (operation) =>
        repository.releaseIdempotencyOperation(operation),
      findById: async (id) => {
        findByIdCalls += 1;
        return repository.findById(id);
      },
      list: (offset, limit) => repository.list(offset, limit),
      count: () => repository.count(),
    };
    const handler = createHttpHandler({
      createTransaction: new CreateTransaction(
        repository,
        new ControlledProvider(),
        { generate: () => transactionId },
        { now: () => baseTime },
        30_000,
      ),
      getTransaction: new GetTransaction(trackingRepository, cache),
      listTransactions: new ListTransactions(trackingRepository),
      rateLimiter: new RedisRateLimiter(redis, 100, 60_000, ratePrefix),
    });

    try {
      const headers = {
        "Content-Type": "application/json",
        "X-Client-Id": "redis-flow-client",
      };
      const created = await handler(
        new Request("http://localhost/transactions", {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": "redis-flow-key" },
          body: JSON.stringify({
            amount: 1099,
            currency: "BRL",
            description: "Redis flow",
          }),
        }),
      );
      const cacheKey = transactionCacheKey(cachePrefix, transactionId);

      expect(created.status).toBe(201);
      expect(
        await redis.execute(() => redisClient.send("GET", [cacheKey])),
      ).toBeNull();

      const firstGet = await handler(
        new Request(`http://localhost/transactions/${transactionId}`, {
          headers,
        }),
      );
      const secondGet = await handler(
        new Request(`http://localhost/transactions/${transactionId}`, {
          headers,
        }),
      );

      expect(firstGet.status).toBe(200);
      expect(secondGet.status).toBe(200);
      expect(await firstGet.json()).toEqual(await secondGet.json());
      expect(findByIdCalls).toBe(1);
      expect(
        await redis.execute(() => redisClient.send("GET", [cacheKey])),
      ).not.toBeNull();
    } finally {
      await redis.execute(() =>
        redisClient.send("DEL", [
          transactionCacheKey(cachePrefix, transactionId),
          `${ratePrefix}:redis-flow-client`,
        ]),
      );
      redisClient.close();
    }
  });
});
