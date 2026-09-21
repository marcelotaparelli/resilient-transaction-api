import type {
  RateLimiter,
  RateLimitResult,
} from "../../application/ports/rate-limiter";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export class InMemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  async consume(clientId: string): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.entries.get(clientId);

    if (entry === undefined || now >= entry.resetAt) {
      this.entries.set(clientId, {
        count: 1,
        resetAt: now + this.windowMs,
      });

      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((entry.resetAt - now) / 1_000),
        ),
      };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
