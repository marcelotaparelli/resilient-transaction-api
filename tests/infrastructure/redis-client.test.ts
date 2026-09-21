import { describe, expect, test } from "bun:test";
import {
  RedisCommandExecutor,
  RedisOperationTimeoutError,
  type RedisCommandClient,
} from "../../src/infrastructure/redis/redis-client";

describe("RedisCommandExecutor", () => {
  test("bounds a Redis operation that never settles", async () => {
    const client: RedisCommandClient = {
      connected: true,
      connect: async () => {},
      send: async () => new Promise<never>(() => {}),
      close: () => {},
    };
    const executor = new RedisCommandExecutor(client, 5);

    await expect(executor.execute(() => client.send("GET", ["key"]))).rejects.toBeInstanceOf(
      RedisOperationTimeoutError,
    );
  });
});
