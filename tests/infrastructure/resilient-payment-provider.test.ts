import { describe, expect, test } from "bun:test";
import {
  ProviderCircuitOpenError,
  ProviderInvalidResponseError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
} from "../../src/application/errors/provider-errors";
import type { Clock } from "../../src/application/ports/clock";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../src/application/ports/payment-provider";
import type { TransactionInput } from "../../src/domain/transaction";
import { CircuitBreaker } from "../../src/infrastructure/providers/circuit-breaker";
import { ResilientPaymentProvider } from "../../src/infrastructure/providers/resilient-payment-provider";
import {
  RetryPolicy,
  type RandomSource,
  type Sleeper,
} from "../../src/infrastructure/providers/retry-policy";

const transaction: TransactionInput = {
  amount: 1099,
  currency: "BRL",
  description: "Order 123",
};
const success: ProviderResult = {
  providerTransactionId: "provider-1",
  decision: "approved",
};

class FixedClock implements Clock {
  constructor(private current = new Date("2026-01-01T00:00:00.000Z")) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class SequenceProvider implements PaymentProvider {
  calls: { transaction: TransactionInput; idempotencyKey: string }[] = [];

  constructor(private readonly outcomes: (ProviderResult | Error)[]) {}

  async process(
    input: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    this.calls.push({ transaction: input, idempotencyKey });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome === undefined) {
      throw new Error("No configured provider outcome");
    }
    return outcome;
  }
}

class RecordingSleeper implements Sleeper {
  delays: number[] = [];

  async sleep(delayMs: number): Promise<void> {
    this.delays.push(delayMs);
  }
}

class SequenceRandom implements RandomSource {
  constructor(private readonly values: number[]) {}

  next(): number {
    const value = this.values.shift();
    if (value === undefined) {
      throw new Error("No configured random value");
    }
    return value;
  }
}

function subject(
  outcomes: (ProviderResult | Error)[],
  options: { threshold?: number; random?: number[]; clock?: FixedClock } = {},
) {
  const provider = new SequenceProvider(outcomes);
  const sleeper = new RecordingSleeper();
  const clock = options.clock ?? new FixedClock();
  const breaker = new CircuitBreaker(
    {
      failureThreshold: options.threshold ?? 10,
      openDurationMs: 1_000,
    },
    clock,
  );
  const resilient = new ResilientPaymentProvider(
    provider,
    new RetryPolicy({
      maxAttempts: 3,
      attemptTimeoutMs: 3_000,
      baseDelayMs: 500,
      maxDelayMs: 2_000,
      jitterRatio: 0.2,
    }),
    breaker,
    sleeper,
    new SequenceRandom(options.random ?? [0, 0]),
  );
  return { provider, sleeper, clock, breaker, resilient };
}

describe("ResilientPaymentProvider", () => {
  test("returns first-attempt success without sleeping", async () => {
    const { resilient, provider, sleeper, breaker } = subject([success]);

    expect(await resilient.process(transaction, "same-key")).toEqual(success);
    expect(provider.calls).toHaveLength(1);
    expect(sleeper.delays).toEqual([]);
    expect(breaker.state()).toBe("closed");
  });

  test("retries 503 once and preserves the idempotency key", async () => {
    const { resilient, provider, sleeper } = subject([
      new ProviderServerError(503),
      success,
    ]);

    expect(await resilient.process(transaction, "same-key")).toEqual(success);
    expect(provider.calls.map((call) => call.idempotencyKey)).toEqual([
      "same-key",
      "same-key",
    ]);
    expect(sleeper.delays).toEqual([500]);
  });

  test("retries two transient failures with exponential jittered delays", async () => {
    const { resilient, provider, sleeper } = subject(
      [new ProviderServerError(503), new ProviderServerError(503), success],
      { random: [1, 0.5] },
    );

    expect(await resilient.process(transaction, "stable-key")).toEqual(success);
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.every((call) => call.idempotencyKey === "stable-key")).toBeTrue();
    expect(sleeper.delays).toEqual([600, 1_100]);
  });

  test("exhausted retries preserve the final ambiguous error", async () => {
    const { resilient, provider, sleeper } = subject([
      new ProviderServerError(503),
      new ProviderServerError(503),
      new ProviderServerError(503),
    ]);

    await expect(
      resilient.process(transaction, "same-key"),
    ).rejects.toBeInstanceOf(ProviderServerError);
    expect(provider.calls).toHaveLength(3);
    expect(sleeper.delays).toEqual([500, 1_000]);
  });

  test("retries timeout, network failure, 429, 500, 502, 503 and 504", async () => {
    const errors = [
      new ProviderTimeoutError(),
      new ProviderNetworkError(),
      new ProviderRateLimitedError(),
      new ProviderServerError(500),
      new ProviderServerError(502),
      new ProviderServerError(503),
      new ProviderServerError(504),
    ];

    for (const error of errors) {
      const { resilient, provider, sleeper } = subject([error, success]);
      expect(await resilient.process(transaction, "same-key")).toEqual(success);
      expect(provider.calls).toHaveLength(2);
      expect(sleeper.delays).toEqual([500]);
    }
  });

  test("does not retry permanent 4xx rejections", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const { resilient, provider, sleeper, breaker } = subject([
        new ProviderRejectedError(status),
      ]);
      await expect(
        resilient.process(transaction, "key"),
      ).rejects.toBeInstanceOf(ProviderRejectedError);
      expect(provider.calls).toHaveLength(1);
      expect(sleeper.delays).toEqual([]);
      expect(breaker.state()).toBe("closed");
    }
  });

  test("does not retry invalid JSON/schema classification and counts it as breaker failure", async () => {
    const { resilient, provider, sleeper, breaker } = subject(
      [new ProviderInvalidResponseError()],
      { threshold: 1 },
    );

    await expect(
      resilient.process(transaction, "key"),
    ).rejects.toBeInstanceOf(ProviderInvalidResponseError);
    expect(provider.calls).toHaveLength(1);
    expect(sleeper.delays).toEqual([]);
    expect(breaker.state()).toBe("open");
  });

  test("429 is retried but does not open the breaker when exhausted", async () => {
    const { resilient, provider, breaker } = subject(
      [
        new ProviderRateLimitedError(),
        new ProviderRateLimitedError(),
        new ProviderRateLimitedError(),
      ],
      { threshold: 1 },
    );

    await expect(
      resilient.process(transaction, "key"),
    ).rejects.toBeInstanceOf(ProviderRateLimitedError);
    expect(provider.calls).toHaveLength(3);
    expect(breaker.state()).toBe("closed");
  });

  test("opens after final qualifying failures and rejects without calling provider", async () => {
    const clock = new FixedClock();
    const { resilient, provider, breaker } = subject(
      [new ProviderServerError(503), new ProviderServerError(503), new ProviderServerError(503)],
      { threshold: 1, clock },
    );
    await expect(resilient.process(transaction, "first")).rejects.toBeInstanceOf(
      ProviderServerError,
    );
    expect(breaker.state()).toBe("open");

    await expect(resilient.process(transaction, "second")).rejects.toBeInstanceOf(
      ProviderCircuitOpenError,
    );
    expect(provider.calls).toHaveLength(3);
  });

  test("a half-open probe closes on success", async () => {
    const clock = new FixedClock();
    const { resilient, breaker } = subject(
      [
        new ProviderServerError(503),
        new ProviderServerError(503),
        new ProviderServerError(503),
        success,
      ],
      { threshold: 1, clock },
    );
    await expect(resilient.process(transaction, "first")).rejects.toBeDefined();
    clock.advance(1_000);

    expect(await resilient.process(transaction, "probe")).toEqual(success);
    expect(breaker.state()).toBe("closed");
  });
});
