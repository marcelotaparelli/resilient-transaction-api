import type {
  RateLimiter,
  RateLimitResult,
} from "../../application/ports/rate-limiter";
import type {
  RedisCommandExecutor,
  RedisFailureReporter,
} from "../redis/redis-client";
import { rateLimitKey } from "../redis/redis-keys";

const consumeFixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

function parseResult(value: unknown): { count: number; ttlMs: number } {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("Redis rate limiter returned an invalid result");
  }

  const count = Number(value[0]);
  const ttlMs = Number(value[1]);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 0
  ) {
    throw new Error("Redis rate limiter returned an invalid result");
  }

  return { count, ttlMs };
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisCommandExecutor,
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly keyPrefix: string,
    private readonly reportFailure: RedisFailureReporter = () => {},
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new Error("Rate limit maximum must be a positive safe integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error("Rate limit window must be a positive safe integer");
    }
    rateLimitKey(keyPrefix, "validation");
  }

  async consume(clientId: string): Promise<RateLimitResult> {
    try {
      const key = rateLimitKey(this.keyPrefix, clientId);
      const raw = await this.redis.execute(() =>
        this.redis.client.send("EVAL", [
          consumeFixedWindowScript,
          "1",
          key,
          String(this.windowMs),
        ]),
      );
      const { count, ttlMs } = parseResult(raw);

      if (count <= this.maxRequests) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
      };
    } catch {
      try {
        this.reportFailure("rate_limit_consume");
      } catch {
        // Failure reporting must not change the explicit fail-open policy.
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}
