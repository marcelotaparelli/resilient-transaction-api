import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import {
  InvalidTransactionCacheEntryError,
  RedisTransactionCache,
} from "../../src/infrastructure/cache/redis-transaction-cache";
import {
  RedisCommandExecutor,
  type RedisCommandClient,
} from "../../src/infrastructure/redis/redis-client";

const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
  providerTransactionId: "provider-1",
  status: "approved",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

class RedisStub implements RedisCommandClient {
  readonly connected = true;
  calls: { command: string; arguments_: string[] }[] = [];
  responses: unknown[] = [];

  async connect(): Promise<void> {}

  async send(command: string, arguments_: string[]): Promise<unknown> {
    this.calls.push({ command, arguments_ });
    return this.responses.shift() ?? null;
  }

  close(): void {}
}

describe("RedisTransactionCache", () => {
  test("returns a validated hit and reconstructs createdAt", async () => {
    const client = new RedisStub();
    client.responses.push(
      JSON.stringify({
        ...transaction,
        createdAt: transaction.createdAt.toISOString(),
      }),
    );
    const cache = new RedisTransactionCache(
      new RedisCommandExecutor(client, 100),
      "transaction-cache:v1",
      3_600,
    );

    expect(await cache.get(transaction.id)).toEqual(transaction);
    expect(client.calls[0]).toEqual({
      command: "GET",
      arguments_: [`transaction-cache:v1:${transaction.id}`],
    });
  });

  test("returns null for a miss", async () => {
    const client = new RedisStub();
    client.responses.push(null);
    const cache = new RedisTransactionCache(
      new RedisCommandExecutor(client, 100),
      "transaction-cache:v1",
      3_600,
    );

    expect(await cache.get(transaction.id)).toBeNull();
  });

  test("writes an explicit JSON shape with an atomic TTL", async () => {
    const client = new RedisStub();
    client.responses.push("OK");
    const cache = new RedisTransactionCache(
      new RedisCommandExecutor(client, 100),
      "transaction-cache:v1",
      3_600,
    );

    await cache.set(transaction);

    expect(client.calls[0]?.command).toBe("SET");
    expect(client.calls[0]?.arguments_[0]).toBe(
      `transaction-cache:v1:${transaction.id}`,
    );
    expect(client.calls[0]?.arguments_.slice(2)).toEqual(["EX", "3600"]);
    expect(JSON.parse(client.calls[0]?.arguments_[1] ?? "")).toEqual({
      ...transaction,
      createdAt: transaction.createdAt.toISOString(),
    });
  });

  test("deletes invalid cache data and never returns it", async () => {
    const client = new RedisStub();
    client.responses.push('{"status":"processing"}', 1);
    const failures: string[] = [];
    const cache = new RedisTransactionCache(
      new RedisCommandExecutor(client, 100),
      "transaction-cache:v1",
      3_600,
      (operation) => failures.push(operation),
    );

    await expect(cache.get(transaction.id)).rejects.toBeInstanceOf(
      InvalidTransactionCacheEntryError,
    );
    expect(client.calls.map((call) => call.command)).toEqual(["GET", "DEL"]);
    expect(failures).toEqual(["transaction_cache_read"]);
  });
});
