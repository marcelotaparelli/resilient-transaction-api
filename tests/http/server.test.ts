import { describe, expect, test } from "bun:test";
import {
  ProviderCircuitOpenError,
  ProviderInvalidResponseError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../src/application/errors/provider-errors";
import { IdempotencyConflictError } from "../../src/application/errors/idempotency-conflict-error";
import { IdempotencyInProgressError } from "../../src/application/errors/idempotency-in-progress-error";
import { TransactionNotFoundError } from "../../src/application/errors/transaction-not-found-error";
import { createHttpHandler } from "../../src/http/server";
import type { Transaction } from "../../src/domain/transaction";

const transaction: Transaction = {
  id: "00000000-0000-4000-8000-000000000001",
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
  status: "approved",
  providerTransactionId: "provider-123",
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
};

const validBody = JSON.stringify({
  amount: 1099,
  currency: "brl",
  description: "Order 123",
});

function dependencies() {
  return {
    createTransaction: {
      execute: async () => ({ transaction, created: true }),
    },
    getTransaction: {
      execute: async () => transaction,
    },
    listTransactions: {
      execute: async (page: number, limit: number) => ({
        data: [transaction],
        pagination: { page, limit, total: 1, totalPages: 1 },
      }),
    },
    rateLimiter: {
      consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
  };
}

function postRequest(): Request {
  return new Request("http://localhost/transactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": "test-client",
      "Idempotency-Key": "test-key",
    },
    body: validBody,
  });
}

describe("createHttpHandler", () => {
  test("handles a request directly without opening a network socket", async () => {
    const handler = createHttpHandler(dependencies());

    const response = await handler(postRequest());
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ...transaction,
      createdAt: transaction.createdAt.toISOString(),
    });
  });

  test("returns a transaction by its internal ID", async () => {
    const handler = createHttpHandler(dependencies());
    const response = await handler(
      new Request(`http://localhost/transactions/${transaction.id}`, {
        headers: { "X-Client-Id": "test-client" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...transaction,
      createdAt: transaction.createdAt.toISOString(),
    });
  });

  test("maps TransactionNotFoundError to a predictable 404 envelope", async () => {
    const deps = dependencies();
    deps.getTransaction.execute = async () => {
      throw new TransactionNotFoundError();
    };
    const handler = createHttpHandler(deps);

    const response = await handler(
      new Request(`http://localhost/transactions/${transaction.id}`, {
        headers: { "X-Client-Id": "test-client" },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "TRANSACTION_NOT_FOUND",
        message: "Transaction not found",
      },
    });
  });

  test("maps every provider error to its HTTP contract", async () => {
    const cases = [
      [new ProviderTimeoutError(), 504, "PROVIDER_TIMEOUT"],
      [new ProviderUnavailableError(), 503, "PROVIDER_UNAVAILABLE"],
      [new ProviderNetworkError(), 503, "PROVIDER_UNAVAILABLE"],
      [new ProviderRateLimitedError(), 503, "PROVIDER_UNAVAILABLE"],
      [new ProviderServerError(503), 503, "PROVIDER_UNAVAILABLE"],
      [new ProviderCircuitOpenError(), 503, "PROVIDER_UNAVAILABLE"],
      [new ProviderInvalidResponseError(), 502, "PROVIDER_INVALID_RESPONSE"],
      [new ProviderRejectedError(), 502, "PROVIDER_REJECTED"],
    ] as const;

    for (const [error, expectedStatus, expectedCode] of cases) {
      const deps = dependencies();
      deps.createTransaction.execute = async () => {
        throw error;
      };
      const response = await createHttpHandler(deps)(postRequest());
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };

      expect(response.status).toBe(expectedStatus);
      expect(body.error.code).toBe(expectedCode);
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });

  test("maps idempotency conflict to a stable 409 envelope", async () => {
    const deps = dependencies();
    deps.createTransaction.execute = async () => {
      throw new IdempotencyConflictError();
    };

    const response = await createHttpHandler(deps)(postRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "Idempotency key was already used for a different transaction",
      },
    });
  });

  test("returns bounded processing response with Retry-After", async () => {
    const deps = dependencies();
    deps.createTransaction.execute = async () => {
      throw new IdempotencyInProgressError();
    };

    const response = await createHttpHandler(deps)(postRequest());

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_OPERATION_IN_PROGRESS" },
    });
  });

  test("does not expose unexpected error messages or stack traces", async () => {
    const deps = dependencies();
    deps.createTransaction.execute = async () => {
      throw new Error("sensitive database detail");
    };
    const response = await createHttpHandler(deps)(postRequest());
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).toBe(
      '{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}',
    );
    expect(bodyText).not.toContain("sensitive database detail");
    expect(bodyText).not.toContain("stack");
  });

  test("rejects unknown pagination parameters", async () => {
    const handler = createHttpHandler(dependencies());
    const response = await handler(
      new Request("http://localhost/transactions?page=1&limit=20&all=true", {
        headers: { "X-Client-Id": "test-client" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_PAGINATION" },
    });
  });
});
