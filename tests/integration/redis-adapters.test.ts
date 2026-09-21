import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import type { TransactionRepository } from "../../src/application/ports/transaction-repository";
import { GetTransaction } from "../../src/application/use-cases/get-transaction";
import {
  InvalidTransactionCacheEntryError,
  RedisTransactionCache,
} from "../../src/infrastructure/cache/redis-transaction-cache";
import { RedisRateLimiter } from "../../src/infrastructure/rate-limit/redis-rate-limiter";
import {
  createBunRedisClient,
  RedisCommandExecutor,
  type RedisCommandClient,
} from "../../src/infrastructure/redis/redis-client";
import {
  rateLimitKey,
  transactionCacheKey,
} from "../../src/infrastructure/redis/redis-keys";

const redisUrl = Bun.env.TEST_REDIS_URL;
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;
const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000101",
  amount: 1099,
  currency: "BRL",
  description: "Redis integration",
  providerTransactionId: "provider-redis-1",
  status: "approved",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

function repositoryReturning(
  value: Transaction | null,
  onFind: () => void = () => {},
): TransactionRepository {
  return {
    claimIdempotencyOperation: async () => ({ kind: "new_claim" }),
    completeIdempotencyOperation: async () => {},
    releaseIdempotencyOperation: async () => {},
    findById: async () => {
      onFind();
      return value;
    },
    list: async () => [],
    count: async () => 0,
  };
}

describeWithRedis("Redis adapters", () => {
  const clients: RedisCommandClient[] = [];
  let client: RedisCommandClient;
  let redis: RedisCommandExecutor;

  function createExecutor(url = redisUrl as string): RedisCommandExecutor {
    const created = createBunRedisClient(url, 250);
    clients.push(created);
    return new RedisCommandExecutor(created, 250);
  }

  beforeAll(async () => {
    redis = createExecutor();
    client = redis.client;
    await redis.execute(() => client.send("PING", []));
  });

  beforeEach(async () => {
    await redis.execute(() => client.send("FLUSHDB", []));
  });

  afterAll(() => {
    for (const current of clients) current.close();
  });

  test("fixed window allows through the limit, rejects above it and sets TTL", async () => {
    const limiter = new RedisRateLimiter(redis, 3, 2_000, "rate-limit:test");

    expect(await limiter.consume("client-a")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect((await limiter.consume("client-a")).allowed).toBeTrue();
    expect((await limiter.consume("client-a")).allowed).toBeTrue();
    const rejected = await limiter.consume("client-a");
    const ttl = Number(
      await redis.execute(() =>
        client.send("PTTL", [rateLimitKey("rate-limit:test", "client-a")]),
      ),
    );

    expect(rejected.allowed).toBeFalse();
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2_000);
  });

  test("keeps clients independent and permits a new short window", async () => {
    const limiter = new RedisRateLimiter(redis, 1, 40, "rate-limit:test");

    expect((await limiter.consume("client-a")).allowed).toBeTrue();
    expect((await limiter.consume("client-a")).allowed).toBeFalse();
    expect((await limiter.consume("client-b")).allowed).toBeTrue();
    await Bun.sleep(60);
    expect((await limiter.consume("client-a")).allowed).toBeTrue();
  });

  test("enforces the exact limit under concurrent requests", async () => {
    const limiter = new RedisRateLimiter(redis, 5, 2_000, "rate-limit:test");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.consume("concurrent-client")),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(25);
  });

  test("shares a rate-limit counter across adapter instances", async () => {
    const first = new RedisRateLimiter(redis, 2, 2_000, "rate-limit:test");
    const second = new RedisRateLimiter(
      createExecutor(),
      2,
      2_000,
      "rate-limit:test",
    );

    expect((await first.consume("shared-client")).allowed).toBeTrue();
    expect((await second.consume("shared-client")).allowed).toBeTrue();
    expect((await second.consume("shared-client")).allowed).toBeFalse();
  });

  test("fails open when a real Redis endpoint is unavailable", async () => {
    const unavailable = createExecutor("redis://127.0.0.1:6399/15");
    const limiter = new RedisRateLimiter(
      unavailable,
      1,
      1_000,
      "rate-limit:test",
    );

    expect(await limiter.consume("client-a")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  test("falls back to PostgreSQL through the use case when real Redis is unavailable", async () => {
    const unavailable = createExecutor("redis://127.0.0.1:6399/15");
    const cache = new RedisTransactionCache(
      unavailable,
      "transaction-cache:test",
      30,
    );
    let databaseCalls = 0;
    const useCase = new GetTransaction(
      repositoryReturning(transaction, () => {
        databaseCalls += 1;
      }),
      cache,
    );

    expect(await useCase.execute(transaction.id)).toEqual(transaction);
    expect(databaseCalls).toBe(1);
  });

  test("shares a validated cached Transaction and applies TTL", async () => {
    const first = new RedisTransactionCache(
      redis,
      "transaction-cache:test",
      30,
    );
    const second = new RedisTransactionCache(
      createExecutor(),
      "transaction-cache:test",
      30,
    );

    await first.set(transaction);
    const ttl = Number(
      await redis.execute(() =>
        client.send("TTL", [
          transactionCacheKey("transaction-cache:test", transaction.id),
        ]),
      ),
    );

    expect(await second.get(transaction.id)).toEqual(transaction);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  test("returns a miss after the cache key expires", async () => {
    const cache = new RedisTransactionCache(
      redis,
      "transaction-cache:test",
      30,
    );
    const key = transactionCacheKey("transaction-cache:test", transaction.id);
    await cache.set(transaction);
    await redis.execute(() => client.send("PEXPIRE", [key, "20"]));
    await Bun.sleep(40);

    expect(await cache.get(transaction.id)).toBeNull();
  });

  test("rejects and removes corrupt or processing-shaped cache values", async () => {
    const cache = new RedisTransactionCache(
      redis,
      "transaction-cache:test",
      30,
    );
    const key = transactionCacheKey("transaction-cache:test", transaction.id);
    await redis.execute(() =>
      client.send("SET", [key, JSON.stringify({ status: "processing" })]),
    );

    await expect(cache.get(transaction.id)).rejects.toBeInstanceOf(
      InvalidTransactionCacheEntryError,
    );
    expect(
      await redis.execute(() => client.send("GET", [key])),
    ).toBeNull();
  });

  test("falls back to PostgreSQL instead of returning a corrupt cache value", async () => {
    const cache = new RedisTransactionCache(
      redis,
      "transaction-cache:test",
      30,
    );
    const key = transactionCacheKey("transaction-cache:test", transaction.id);
    await redis.execute(() => client.send("SET", [key, "not-json"]));
    let databaseCalls = 0;
    const useCase = new GetTransaction(
      repositoryReturning(transaction, () => {
        databaseCalls += 1;
      }),
      cache,
    );

    expect(await useCase.execute(transaction.id)).toEqual(transaction);
    expect(databaseCalls).toBe(1);
  });

  test("uses isolated namespaces for cache and rate limiting", async () => {
    const cache = new RedisTransactionCache(
      redis,
      "transaction-cache:test",
      30,
    );
    const limiter = new RedisRateLimiter(redis, 5, 2_000, "rate-limit:test");
    await cache.set(transaction);
    await limiter.consume(transaction.id);

    const cacheExists = await redis.execute(() =>
      client.send("EXISTS", [
        transactionCacheKey("transaction-cache:test", transaction.id),
      ]),
    );
    const rateExists = await redis.execute(() =>
      client.send("EXISTS", [rateLimitKey("rate-limit:test", transaction.id)]),
    );

    expect(cacheExists).toBe(1);
    expect(rateExists).toBe(1);
  });
});
