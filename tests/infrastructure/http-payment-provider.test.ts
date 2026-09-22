import { describe, expect, test } from "bun:test";
import {
  ProviderInvalidResponseError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
} from "../../src/application/errors/provider-errors";
import {
  HttpPaymentProvider,
  type TimeoutScheduler,
} from "../../src/infrastructure/providers/http-payment-provider";
import { ApplicationMetrics } from "../../src/infrastructure/observability/metrics";
import { runWithRequestContext } from "../../src/infrastructure/observability/request-context";

const transaction = {
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
};

class ManualTimeoutScheduler implements TimeoutScheduler {
  callback: (() => void) | null = null;
  delayMs: number | null = null;
  cancelled = false;

  schedule(callback: () => void, delayMs: number) {
    this.callback = callback;
    this.delayMs = delayMs;
    return { cancel: () => (this.cancelled = true) };
  }

  fire(): void {
    this.callback?.();
  }
}

describe("HttpPaymentProvider", () => {
  test("sends one request with the provider idempotency key", async () => {
    const requests: Request[] = [];
    const metrics = new ApplicationMetrics();
    const provider = new HttpPaymentProvider(
      "http://provider/transactions",
      3_000,
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({
          providerTransactionId: "provider-1",
          decision: "approved",
        });
      },
      undefined,
      metrics,
    );

    expect(await runWithRequestContext(
      { requestId: "00000000-0000-4000-8000-000000000080" },
      () => provider.process(transaction, "same-key"),
    )).toEqual({
      providerTransactionId: "provider-1",
      decision: "approved",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe("same-key");
    expect(requests[0]?.headers.get("X-Request-Id")).toBe(
      "00000000-0000-4000-8000-000000000080",
    );
    expect(metrics.value("provider_requests_total")).toBe(1);
  });

  test("classifies provider status codes without retrying in the HTTP adapter", async () => {
    const cases = [
      [429, ProviderRateLimitedError],
      [500, ProviderServerError],
      [502, ProviderServerError],
      [503, ProviderServerError],
      [504, ProviderServerError],
      [400, ProviderRejectedError],
      [401, ProviderRejectedError],
      [403, ProviderRejectedError],
      [404, ProviderRejectedError],
      [409, ProviderRejectedError],
    ] as const;

    for (const [status, ErrorType] of cases) {
      let calls = 0;
      const provider = new HttpPaymentProvider(
        "http://provider/transactions",
        3_000,
        async () => {
          calls += 1;
          return new Response(null, { status });
        },
      );

      await expect(provider.process(transaction, "key")).rejects.toBeInstanceOf(
        ErrorType,
      );
      expect(calls).toBe(1);
    }
  });

  test("treats invalid JSON and invalid schema as ambiguous invalid responses", async () => {
    const invalidJson = new HttpPaymentProvider(
      "http://provider/transactions",
      3_000,
      async () => new Response("not-json"),
    );
    const invalidSchema = new HttpPaymentProvider(
      "http://provider/transactions",
      3_000,
      async () => Response.json({ decision: "approved" }),
    );

    await expect(
      invalidJson.process(transaction, "key"),
    ).rejects.toBeInstanceOf(ProviderInvalidResponseError);
    await expect(
      invalidSchema.process(transaction, "key"),
    ).rejects.toBeInstanceOf(ProviderInvalidResponseError);
  });

  test("aborts a hanging request using a deterministic timeout scheduler", async () => {
    const scheduler = new ManualTimeoutScheduler();
    let observedSignal: AbortSignal | null = null;
    const metrics = new ApplicationMetrics();
    const provider = new HttpPaymentProvider(
      "http://provider/transactions",
      3_000,
      (_input, init) => {
        observedSignal = init?.signal ?? null;
        return new Promise((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
      scheduler,
      metrics,
    );

    const pending = provider.process(transaction, "same-key");
    expect(scheduler.delayMs).toBe(3_000);
    scheduler.fire();

    await expect(pending).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect((observedSignal as AbortSignal | null)?.aborted).toBeTrue();
    expect(scheduler.cancelled).toBeTrue();
    expect(metrics.value("provider_requests_total")).toBe(1);
    expect(metrics.value("provider_timeouts_total")).toBe(1);
    expect(metrics.value("provider_failures_total", { category: "timeout" })).toBe(1);
  });

  test("classifies transport exceptions as network failures", async () => {
    const provider = new HttpPaymentProvider(
      "http://provider/transactions",
      3_000,
      async () => {
        throw new TypeError("connection reset");
      },
    );

    await expect(provider.process(transaction, "key")).rejects.toBeInstanceOf(
      ProviderNetworkError,
    );
  });
});
