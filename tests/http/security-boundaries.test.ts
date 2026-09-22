import { describe, expect, test } from "bun:test";
import type { Transaction } from "../../src/domain/transaction";
import { createHttpHandler } from "../../src/http/server";
import {
  hashApiKey,
  Sha256ServiceAuthenticator,
} from "../../src/http/security/service-authenticator";

const serviceAKey = "service-a-api-key-0000000000000001";
const serviceBKey = "service-b-api-key-0000000000000002";
const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
  providerTransactionId: "provider-123",
  status: "approved",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};
const validBody = JSON.stringify({
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
});
const generatedRequestId = "00000000-0000-4000-8000-000000000098";

type Dependencies = Parameters<typeof createHttpHandler>[0];

function authenticator(): Sha256ServiceAuthenticator {
  return new Sha256ServiceAuthenticator([
    { serviceId: "service-a", apiKeySha256: hashApiKey(serviceAKey) },
    { serviceId: "service-b", apiKeySha256: hashApiKey(serviceBKey) },
  ]);
}

function dependencies(): Dependencies & {
  calls: { create: number; get: number; list: number; rate: string[] };
} {
  const calls = { create: 0, get: 0, list: 0, rate: [] as string[] };
  return {
    calls,
    authenticator: authenticator(),
    maxBodyBytes: 16_384,
    requestIdGenerator: () => generatedRequestId,
    createTransaction: {
      execute: async () => {
        calls.create += 1;
        return { transaction, created: true };
      },
    },
    getTransaction: {
      execute: async () => {
        calls.get += 1;
        return transaction;
      },
    },
    listTransactions: {
      execute: async (page: number, limit: number) => {
        calls.list += 1;
        return {
          data: [transaction],
          pagination: { page, limit, total: 1, totalPages: 1 },
        };
      },
    },
    rateLimiter: {
      consume: async (serviceId: string) => {
        calls.rate.push(serviceId);
        return { allowed: true, retryAfterSeconds: 0 };
      },
    },
  };
}

function authorization(apiKey = serviceAKey): string {
  return `Bearer ${apiKey}`;
}

function postRequest(
  headers: Record<string, string> = {},
  body = validBody,
): Request {
  return new Request("http://localhost/transactions", {
    method: "POST",
    headers: {
      Authorization: authorization(),
      "Content-Type": "application/json",
      "Idempotency-Key": "order-123",
      ...headers,
    },
    body,
  });
}

describe("service authentication boundary", () => {
  const unauthorizedCases: Array<[string, string | null]> = [
    ["missing Authorization", null],
    ["empty Bearer credential", "Bearer "],
    ["unsupported scheme", `Basic ${serviceAKey}`],
    ["invalid credential", "Bearer invalid-api-key-0000000000000000"],
  ];

  for (const [name, value] of unauthorizedCases) {
    test(`rejects ${name} with one public response`, async () => {
      const deps = dependencies();
      const init: RequestInit =
        value === null ? {} : { headers: { Authorization: value } };
      const response = await createHttpHandler(deps)(
        new Request("http://localhost/transactions", init),
      );
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(text).toBe(
        `{"error":{"code":"UNAUTHORIZED","message":"Authentication required","requestId":"${generatedRequestId}"}}`,
      );
      expect(text).not.toContain(serviceAKey);
      expect(deps.calls.rate).toEqual([]);
      expect(deps.calls.list).toBe(0);
    });
  }

  test("resolves the service identity and passes it to the rate limiter", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(
      new Request("http://localhost/transactions", {
        headers: { Authorization: authorization(serviceBKey) },
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.calls.rate).toEqual(["service-b"]);
    expect(deps.calls.list).toBe(1);
  });

  test("ignores X-Client-Id for isolation and cannot reset a service limit", async () => {
    const deps = dependencies();
    const counts = new Map<string, number>();
    deps.rateLimiter.consume = async (serviceId: string) => {
      deps.calls.rate.push(serviceId);
      const count = (counts.get(serviceId) ?? 0) + 1;
      counts.set(serviceId, count);
      return { allowed: count <= 1, retryAfterSeconds: 10 };
    };
    const handler = createHttpHandler(deps);

    const first = await handler(
      new Request("http://localhost/transactions", {
        headers: {
          Authorization: authorization(),
          "X-Client-Id": "caller-selected-a",
        },
      }),
    );
    const bypassAttempt = await handler(
      new Request("http://localhost/transactions", {
        headers: {
          Authorization: authorization(),
          "X-Client-Id": "caller-selected-b",
        },
      }),
    );
    const otherService = await handler(
      new Request("http://localhost/transactions", {
        headers: { Authorization: authorization(serviceBKey) },
      }),
    );

    expect(first.status).toBe(200);
    expect(bypassAttempt.status).toBe(429);
    expect(otherService.status).toBe(200);
    expect(deps.calls.rate).toEqual(["service-a", "service-a", "service-b"]);
  });

  test("keeps authentication fail-closed when the limiter itself fails open", async () => {
    const deps = dependencies();
    deps.rateLimiter.consume = async () => ({
      allowed: true,
      retryAfterSeconds: 0,
    });
    const handler = createHttpHandler(deps);

    const unauthorized = await handler(
      new Request("http://localhost/transactions"),
    );
    const authorized = await handler(
      new Request("http://localhost/transactions", {
        headers: { Authorization: authorization() },
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  test("does not let a cache-backed read bypass authentication", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(
      new Request(`http://localhost/transactions/${transaction.id}`),
    );

    expect(response.status).toBe(401);
    expect(deps.calls.get).toBe(0);
  });

  test("rejects an unexpectedly large Authorization header", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(
      new Request("http://localhost/transactions", {
        headers: { Authorization: `Bearer ${"a".repeat(600)}` },
      }),
    );

    expect(response.status).toBe(401);
    expect(deps.calls.rate).toEqual([]);
  });
});

describe("request body boundary", () => {
  test("accepts a valid JSON body within the configured limit", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(postRequest());

    expect(response.status).toBe(201);
    expect(deps.calls.create).toBe(1);
  });

  test("rejects an oversized streamed body before the use case", async () => {
    const deps = dependencies();
    const oversized = JSON.stringify({
      amount: 1099,
      currency: "BRL",
      description: "x".repeat(17_000),
    });
    const response = await createHttpHandler(deps)(postRequest({}, oversized));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large",
        requestId: generatedRequestId,
      },
    });
    expect(deps.calls.create).toBe(0);
  });

  test("rejects a declared oversized body before authentication and rate limiting", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(
      postRequest({ "Content-Length": "20000" }),
    );

    expect(response.status).toBe(413);
    expect(deps.calls.rate).toEqual([]);
    expect(deps.calls.create).toBe(0);
  });

  test("maps malformed JSON to 400 without reaching the use case", async () => {
    const deps = dependencies();
    const response = await createHttpHandler(deps)(postRequest({}, "{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_JSON" },
    });
    expect(deps.calls.create).toBe(0);
  });

  test("requires application/json and accepts only its UTF-8 parameter", async () => {
    const deps = dependencies();
    const missing = new Request("http://localhost/transactions", {
      method: "POST",
      headers: {
        Authorization: authorization(),
        "Idempotency-Key": "order-123",
      },
      body: validBody,
    });
    const text = postRequest({ "Content-Type": "text/plain" });
    const supported = postRequest({
      "Content-Type": "application/json; charset=utf-8",
    });
    const handler = createHttpHandler(deps);

    expect((await handler(missing)).status).toBe(415);
    expect((await handler(text)).status).toBe(415);
    expect((await handler(supported)).status).toBe(201);
    expect(deps.calls.create).toBe(1);
  });
});

describe("strict input and safe failure boundaries", () => {
  test("rejects missing, oversized, and malformed idempotency keys", async () => {
    const deps = dependencies();
    const handler = createHttpHandler(deps);
    const missingHeaders = {
      Authorization: authorization(),
      "Content-Type": "application/json",
    };

    const missing = await handler(
      new Request("http://localhost/transactions", {
        method: "POST",
        headers: missingHeaders,
        body: validBody,
      }),
    );
    const oversized = await handler(
      postRequest({ "Idempotency-Key": "a".repeat(129) }),
    );
    const malformed = await handler(
      postRequest({ "Idempotency-Key": "contains spaces" }),
    );

    expect(missing.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(deps.calls.create).toBe(0);
  });

  test("rejects invalid IDs and bounded or unexpected pagination", async () => {
    const deps = dependencies();
    const handler = createHttpHandler(deps);
    const options = { headers: { Authorization: authorization() } };

    const invalidId = await handler(
      new Request("http://localhost/transactions/not-a-uuid", options),
    );
    const invalidPage = await handler(
      new Request("http://localhost/transactions?page=1000001", options),
    );
    const invalidLimit = await handler(
      new Request("http://localhost/transactions?limit=101", options),
    );
    const unexpected = await handler(
      new Request("http://localhost/transactions?admin=true", options),
    );

    expect(invalidId.status).toBe(400);
    expect(invalidPage.status).toBe(400);
    expect(invalidLimit.status).toBe(400);
    expect(unexpected.status).toBe(400);
    expect(deps.calls.get).toBe(0);
    expect(deps.calls.list).toBe(0);
  });

  test("keeps transaction validation strict and bounded", async () => {
    const invalidBodies = [
      { amount: 1.5, currency: "BRL", description: "ok" },
      { amount: 100, currency: "BR", description: "ok" },
      { amount: 100, currency: "BRL", description: "x".repeat(201) },
      { amount: 100, currency: "BRL", description: "ok", admin: true },
    ];

    for (const body of invalidBodies) {
      const deps = dependencies();
      const response = await createHttpHandler(deps)(
        postRequest({}, JSON.stringify(body)),
      );
      expect(response.status).toBe(422);
      expect(deps.calls.create).toBe(0);
    }
  });

  test("never exposes infrastructure errors, secrets, or stack traces", async () => {
    const sensitiveValues = [
      "postgres://admin:db-password@database/internal",
      "redis://default:redis-password@cache:6379",
      "provider-client-secret-value",
      serviceAKey,
      "order-123",
    ];

    for (const value of sensitiveValues) {
      const deps = dependencies();
      deps.createTransaction.execute = async () => {
        throw new Error(`internal failure ${value}`);
      };
      const response = await createHttpHandler(deps)(postRequest());
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).toBe(
        `{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","requestId":"${generatedRequestId}"}}`,
      );
      expect(text).not.toContain(value);
      expect(text).not.toContain("stack");
    }
  });
});

describe("operational endpoints", () => {
  test("keeps liveness endpoints unauthenticated", async () => {
    const handler = createHttpHandler(dependencies());
    const legacy = await handler(new Request("http://localhost/health"));
    const live = await handler(new Request("http://localhost/health/live"));

    expect(legacy.status).toBe(200);
    expect(live.status).toBe(200);
  });
});
