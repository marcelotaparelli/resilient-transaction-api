import { describe, expect, test } from "bun:test";
import type { RateLimiter } from "../../src/application/ports/rate-limiter";
import type { TransactionCache } from "../../src/application/ports/transaction-cache";
import type { Transaction } from "../../src/domain/transaction";
import { JsonLogger } from "../../src/infrastructure/observability/logger";
import { ApplicationMetrics } from "../../src/infrastructure/observability/metrics";
import {
  ObservedRateLimiter,
  ObservedTransactionCache,
} from "../../src/infrastructure/observability/observed-adapters";

const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order",
  providerTransactionId: "provider-1",
  status: "approved",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("JsonLogger", () => {
  test("writes one safe JSON object using an explicit field allowlist", () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    logger.log("error", "http.request.failed", {
      requestId: "00000000-0000-4000-8000-000000000001",
      method: "POST",
      route: "/transactions",
      status: 500,
      durationMs: 12.5,
      errorCode: "INTERNAL_ERROR",
      ...({
        Authorization: "Bearer api-key-secret",
        idempotencyKey: "complete-idempotency-key",
        DATABASE_URL: "postgres://user:secret@database/db",
        REDIS_URL: "redis://:secret@redis",
        body: '{"description":"sensitive body"}',
        stack: "private stack",
      } as Record<string, unknown>),
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "error",
      event: "http.request.failed",
      requestId: "00000000-0000-4000-8000-000000000001",
      method: "POST",
      route: "/transactions",
      status: 500,
      durationMs: 12.5,
      errorCode: "INTERNAL_ERROR",
    });
    expect(lines[0]).not.toContain("api-key-secret");
    expect(lines[0]).not.toContain("idempotency-key");
    expect(lines[0]).not.toContain("postgres://");
    expect(lines[0]).not.toContain("redis://");
    expect(lines[0]).not.toContain("sensitive body");
    expect(lines[0]).not.toContain("private stack");
  });
});

describe("ApplicationMetrics", () => {
  test("records HTTP counters, errors and a cumulative fixed-bucket histogram", () => {
    const metrics = new ApplicationMetrics();
    metrics.recordHttp("GET", "/transactions/:id", 200, 0.012);
    metrics.recordHttp("GET", "/transactions/:id", 404, 0.03);
    metrics.recordHttp("POST", "/transactions", 503, 0.6);
    const output = metrics.render();

    expect(metrics.value("http_requests_total", {
      method: "GET",
      route: "/transactions/:id",
      status: "200",
    })).toBe(1);
    expect(metrics.value("http_errors_total", {
      route: "/transactions/:id",
      class: "4xx",
    })).toBe(1);
    expect(metrics.value("http_errors_total", {
      route: "/transactions",
      class: "5xx",
    })).toBe(1);
    expect(output).toContain("# TYPE http_request_duration_seconds histogram");
    expect(output).toContain('le="0.025"');
    expect(output).toContain('le="+Inf"');
  });

  test("renders bounded operational counters without high-cardinality identifiers", () => {
    const metrics = new ApplicationMetrics();
    metrics.providerAttempt();
    metrics.providerRetry();
    metrics.providerTimeout();
    metrics.providerFailure("timeout");
    metrics.circuitOpened();
    metrics.cacheHit();
    metrics.cacheMiss();
    metrics.cacheError("get");
    metrics.rateLimitRejected();
    metrics.redisError("rate_limit");
    metrics.databaseError("readiness");
    const output = metrics.render();

    for (const name of [
      "provider_requests_total",
      "provider_retries_total",
      "provider_timeouts_total",
      "provider_failures_total",
      "circuit_open_total",
      "cache_hit_total",
      "cache_miss_total",
      "cache_error_total",
      "rate_limit_rejected_total",
      "redis_errors_total",
      "database_errors_total",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).not.toContain("requestId");
    expect(output).not.toContain("serviceId");
    expect(output).not.toContain(transaction.id);
  });

  test("normalizes arbitrary HTTP label values to bounded fallbacks", () => {
    const metrics = new ApplicationMetrics();
    metrics.recordHttp("CUSTOM-a3f3e8", `/private/${transaction.id}`, 799, 0.1);
    const output = metrics.render();

    expect(output).toContain('method="OTHER"');
    expect(output).toContain('route="unmatched"');
    expect(output).toContain('status="500"');
    expect(output).not.toContain("CUSTOM-a3f3e8");
    expect(output).not.toContain(transaction.id);
  });
});

describe("observed adapters", () => {
  test("records cache hit, miss and error without changing behavior", async () => {
    const metrics = new ApplicationMetrics();
    let value: Transaction | null = transaction;
    const cache: TransactionCache = {
      get: async () => value,
      set: async () => {},
    };
    const observed = new ObservedTransactionCache(cache, metrics);

    expect(await observed.get(transaction.id)).toEqual(transaction);
    value = null;
    expect(await observed.get(transaction.id)).toBeNull();
    cache.get = async () => {
      throw new Error("redis unavailable");
    };
    await expect(observed.get(transaction.id)).rejects.toThrow();

    expect(metrics.value("cache_hit_total")).toBe(1);
    expect(metrics.value("cache_miss_total")).toBe(1);
    expect(metrics.value("cache_error_total", { operation: "get" })).toBe(1);
  });

  test("counts only actual rate-limit rejections", async () => {
    const metrics = new ApplicationMetrics();
    let allowed = true;
    const limiter: RateLimiter = {
      consume: async () => ({ allowed, retryAfterSeconds: allowed ? 0 : 1 }),
    };
    const observed = new ObservedRateLimiter(limiter, metrics);

    await observed.consume("service-a");
    allowed = false;
    await observed.consume("service-a");
    expect(metrics.value("rate_limit_rejected_total")).toBe(1);
  });
});
