import { describe, expect, test } from "bun:test";
import type { Clock } from "../../src/application/ports/clock";
import { CircuitBreaker } from "../../src/infrastructure/providers/circuit-breaker";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

describe("CircuitBreaker", () => {
  test("transitions closed to open at the configured failure threshold", () => {
    const clock = new MutableClock(new Date("2026-01-01T00:00:00.000Z"));
    const breaker = new CircuitBreaker(
      { failureThreshold: 2, openDurationMs: 1_000 },
      clock,
    );
    const first = breaker.acquire();
    expect(first).not.toBeNull();
    breaker.recordFailure(first!);
    expect(breaker.state()).toBe("closed");

    const second = breaker.acquire();
    expect(second).not.toBeNull();
    breaker.recordFailure(second!);
    expect(breaker.state()).toBe("open");
    expect(breaker.acquire()).toBeNull();
  });

  test("allows only one half-open probe and closes after success", () => {
    const clock = new MutableClock(new Date("2026-01-01T00:00:00.000Z"));
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openDurationMs: 1_000 },
      clock,
    );
    breaker.recordFailure(breaker.acquire()!);
    clock.advance(1_000);

    expect(breaker.state()).toBe("half_open");
    const probe = breaker.acquire();
    expect(probe?.mode).toBe("half_open");
    expect(breaker.acquire()).toBeNull();

    breaker.recordSuccess(probe!);
    expect(breaker.state()).toBe("closed");
    expect(breaker.acquire()?.mode).toBe("closed");
  });

  test("a failed half-open probe reopens for a full interval", () => {
    const clock = new MutableClock(new Date("2026-01-01T00:00:00.000Z"));
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, openDurationMs: 1_000 },
      clock,
    );
    breaker.recordFailure(breaker.acquire()!);
    clock.advance(1_000);
    const probe = breaker.acquire();
    breaker.recordFailure(probe!);

    expect(breaker.state()).toBe("open");
    clock.advance(999);
    expect(breaker.acquire()).toBeNull();
    clock.advance(1);
    expect(breaker.acquire()?.mode).toBe("half_open");
  });
});
