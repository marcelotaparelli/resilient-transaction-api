import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import { createHttpHandler } from "../../src/http/server";
import { JsonLogger } from "../../src/infrastructure/observability/logger";
import { ApplicationMetrics } from "../../src/infrastructure/observability/metrics";
import { InFlightRequestTracker } from "../../src/infrastructure/operability/lifecycle";

const generatedId = "00000000-0000-4000-8000-000000000070";
const suppliedId = "A0000000-0000-4000-8000-000000000071";
const apiKey = "operational-api-key-00000000000001";
const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order",
  providerTransactionId: "provider-1",
  status: "approved",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

type Dependencies = Parameters<typeof createHttpHandler>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    authenticator: {
      authenticate: async (key) =>
        key === apiKey ? { id: "operational-service" } : null,
    },
    maxBodyBytes: 16_384,
    requestIdGenerator: () => generatedId,
    createTransaction: {
      execute: async () => ({ transaction, created: true }),
    },
    getTransaction: { execute: async () => transaction },
    listTransactions: {
      execute: async (page, limit) => ({
        data: [transaction],
        pagination: { page, limit, total: 1, totalPages: 1 },
      }),
    },
    rateLimiter: {
      consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
    ...overrides,
  };
}

function authenticatedGet(path: string, requestId?: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(requestId === undefined ? {} : { "X-Request-Id": requestId }),
    },
  });
}

describe("HTTP request IDs and structured logs", () => {
  test("generates, returns and includes a request ID in error envelopes", async () => {
    const response = await createHttpHandler(dependencies())(
      new Request("http://localhost/transactions"),
    );
    const body = (await response.json()) as { error: { requestId: string } };

    expect(response.status).toBe(401);
    expect(response.headers.get("X-Request-Id")).toBe(generatedId);
    expect(body.error.requestId).toBe(generatedId);
  });

  test("preserves a valid UUID and replaces invalid or oversized IDs", async () => {
    const handler = createHttpHandler(dependencies());
    const preserved = await handler(authenticatedGet("/transactions", suppliedId));
    const invalid = await handler(authenticatedGet("/transactions", "caller-value"));
    const oversized = await handler(
      authenticatedGet("/transactions", "a".repeat(1_000)),
    );

    expect(preserved.headers.get("X-Request-Id")).toBe(suppliedId);
    expect(invalid.headers.get("X-Request-Id")).toBe(generatedId);
    expect(oversized.headers.get("X-Request-Id")).toBe(generatedId);
  });

  test("generates different IDs for independent requests", async () => {
    const ids = [
      "00000000-0000-4000-8000-000000000072",
      "00000000-0000-4000-8000-000000000073",
    ];
    const handler = createHttpHandler(
      dependencies({ requestIdGenerator: () => ids.shift() ?? generatedId }),
    );
    const first = await handler(authenticatedGet("/transactions"));
    const second = await handler(authenticatedGet("/transactions"));
    expect(first.headers.get("X-Request-Id")).not.toBe(
      second.headers.get("X-Request-Id"),
    );
  });

  test("falls back to a safe UUID if an injected generator is invalid", async () => {
    const handler = createHttpHandler(
      dependencies({ requestIdGenerator: () => "unsafe-generated-value" }),
    );
    const response = await handler(authenticatedGet("/transactions"));
    expect(response.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("logs safe low-cardinality HTTP completion fields as JSON", async () => {
    const lines: string[] = [];
    const metrics = new ApplicationMetrics();
    const logger = new JsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    const times = [10, 25];
    const handler = createHttpHandler(
      dependencies({
        logger,
        metrics,
        monotonicNow: () => times.shift() ?? 25,
      }),
    );
    const request = authenticatedGet(`/transactions/${transaction.id}`);
    request.headers.set("Idempotency-Key", "must-not-be-logged");
    request.headers.set("X-Untrusted-Body", '{"secret":"payload"}');
    const response = await handler(request);
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(parsed).toMatchObject({
      event: "http.request.completed",
      requestId: generatedId,
      method: "GET",
      route: "/transactions/:id",
      status: 200,
      durationMs: 15,
    });
    expect(lines[0]).not.toContain(transaction.id);
    expect(lines[0]).not.toContain(apiKey);
    expect(lines[0]).not.toContain("operational-service");
    expect(lines[0]).not.toContain("must-not-be-logged");
    expect(lines[0]).not.toContain("payload");
  });

  test("logs an unexpected 500 without message or stack", async () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));
    const response = await createHttpHandler(
      dependencies({
        logger,
        createTransaction: {
          execute: async () => {
            throw new Error("postgres://user:secret@database with private stack");
          },
        },
      }),
    )(
      new Request("http://localhost/transactions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "secret-key-value",
        },
        body: JSON.stringify({
          amount: 1099,
          currency: "BRL",
          description: "private body",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-Id")).toBe(generatedId);
    expect(lines.at(-1)).toContain('"event":"http.request.failed"');
    expect(lines.at(-1)).toContain('"errorCode":"INTERNAL_ERROR"');
    expect(lines.at(-1)).not.toContain("postgres://");
    expect(lines.at(-1)).not.toContain("private stack");
    expect(lines.at(-1)).not.toContain("private body");
    expect(lines.at(-1)).not.toContain("secret-key-value");
  });
});

describe("operational HTTP endpoints", () => {
  test("exposes Prometheus text without high-cardinality values", async () => {
    const metrics = new ApplicationMetrics();
    const handler = createHttpHandler(dependencies({ metrics }));
    await handler(authenticatedGet(`/transactions/${transaction.id}`));
    const response = await handler(new Request("http://localhost/metrics"));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(text).toContain("http_requests_total");
    expect(text).toContain('route="/transactions/:id"');
    expect(text).not.toContain(transaction.id);
    expect(text).not.toContain("operational-service");
    expect(text).not.toContain(generatedId);
  });

  test("liveness never invokes dependency readiness", async () => {
    let readinessCalls = 0;
    const handler = createHttpHandler(
      dependencies({
        readiness: {
          check: async () => {
            readinessCalls += 1;
            throw new Error("dependencies unavailable");
          },
        },
      }),
    );
    expect((await handler(new Request("http://localhost/health/live"))).status).toBe(200);
    expect(readinessCalls).toBe(0);
  });

  test("maps ready, degraded and not-ready states without internal details", async () => {
    for (const [status, expectedHttp] of [
      ["ready", 200],
      ["degraded", 200],
      ["not_ready", 503],
    ] as const) {
      const response = await createHttpHandler(
        dependencies({ readiness: { check: async () => ({ status }) } }),
      )(new Request("http://localhost/health/ready"));
      expect(response.status).toBe(expectedHttp);
      expect(await response.json()).toEqual({ status });
    }
  });

  test("rejects new business work after shutdown starts", async () => {
    const tracker = new InFlightRequestTracker();
    tracker.startShutdown();
    let createCalls = 0;
    const handler = createHttpHandler(
      dependencies({
        requestTracker: tracker,
        createTransaction: {
          execute: async () => {
            createCalls += 1;
            return { transaction, created: true };
          },
        },
      }),
    );
    const response = await handler(
      new Request("http://localhost/transactions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "shutdown-key",
        },
        body: JSON.stringify({
          amount: 1099,
          currency: "BRL",
          description: "Shutdown",
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Request-Id")).toBe(generatedId);
    expect(createCalls).toBe(0);
  });

  test("tracks in-flight work and decrements in finally", async () => {
    const tracker = new InFlightRequestTracker();
    let finish: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const handler = createHttpHandler(
      dependencies({
        requestTracker: tracker,
        getTransaction: {
          execute: async () => {
            markStarted?.();
            await new Promise<void>((resolve) => { finish = resolve; });
            return transaction;
          },
        },
      }),
    );
    const pending = handler(authenticatedGet(`/transactions/${transaction.id}`));
    await started;
    expect(tracker.activeRequests()).toBe(1);
    finish?.();
    expect((await pending).status).toBe(200);
    expect(tracker.activeRequests()).toBe(0);
  });
});
