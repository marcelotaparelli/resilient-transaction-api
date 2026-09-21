import { describe, expect, test } from "bun:test";
import { RedisRateLimiter } from "../../src/infrastructure/rate-limit/redis-rate-limiter";
import {
  RedisCommandExecutor,
  type RedisCommandClient,
} from "../../src/infrastructure/redis/redis-client";

class RedisStub implements RedisCommandClient {
  readonly connected = true;
  calls: { command: string; arguments_: string[] }[] = [];
  response: unknown = [1, 60_000];
  error: Error | null = null;

  async connect(): Promise<void> {}

  async send(command: string, arguments_: string[]): Promise<unknown> {
    this.calls.push({ command, arguments_ });
    if (this.error !== null) throw this.error;
    return this.response;
  }

  close(): void {}
}

describe("RedisRateLimiter", () => {
  test("uses an atomic Lua operation with an isolated encoded key", async () => {
    const client = new RedisStub();
    const limiter = new RedisRateLimiter(
      new RedisCommandExecutor(client, 100),
      5,
      60_000,
      "rate-limit:v1",
    );

    expect(await limiter.consume("client:one")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.command).toBe("EVAL");
    expect(client.calls[0]?.arguments_.slice(1)).toEqual([
      "1",
      "rate-limit:v1:client%3Aone",
      "60000",
    ]);
  });

  test("rejects above the limit with Retry-After derived from Redis PTTL", async () => {
    const client = new RedisStub();
    client.response = [6, 17_001];
    const limiter = new RedisRateLimiter(
      new RedisCommandExecutor(client, 100),
      5,
      60_000,
      "rate-limit:v1",
    );

    expect(await limiter.consume("client-one")).toEqual({
      allowed: false,
      retryAfterSeconds: 18,
    });
  });

  test("fails open explicitly when Redis is unavailable or malformed", async () => {
    const unavailable = new RedisStub();
    unavailable.error = new Error("connection refused");
    const malformed = new RedisStub();
    malformed.response = "unexpected";

    for (const client of [unavailable, malformed]) {
      const failures: string[] = [];
      const limiter = new RedisRateLimiter(
        new RedisCommandExecutor(client, 100),
        5,
        60_000,
        "rate-limit:v1",
        (operation) => failures.push(operation),
      );
      expect(await limiter.consume("client-one")).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
      expect(failures).toEqual(["rate_limit_consume"]);
    }

    const limiterWithBrokenReporter = new RedisRateLimiter(
      new RedisCommandExecutor(unavailable, 100),
      5,
      60_000,
      "rate-limit:v1",
      () => {
        throw new Error("reporter unavailable");
      },
    );
    expect(await limiterWithBrokenReporter.consume("client-one")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });
});
