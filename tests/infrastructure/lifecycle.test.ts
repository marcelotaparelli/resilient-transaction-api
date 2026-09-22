import { describe, expect, test } from "bun:test";
import type { OperationalLogger } from "../../src/infrastructure/observability/logger";
import {
  GracefulShutdownCoordinator,
  InFlightRequestTracker,
  registerShutdownSignals,
} from "../../src/infrastructure/operability/lifecycle";
import { ReadinessService } from "../../src/infrastructure/operability/readiness";

function recordingLogger(events: string[]): OperationalLogger {
  return { log: (_level, event) => events.push(event) };
}

describe("graceful shutdown", () => {
  test("waits for an in-flight request then closes HTTP, Redis and PostgreSQL", async () => {
    const tracker = new InFlightRequestTracker();
    const release = tracker.begin();
    const calls: string[] = [];
    const coordinator = new GracefulShutdownCoordinator(
      tracker,
      {
        stopHttp: async (force) => { calls.push(`http:${force}`); },
        closeRedis: () => { calls.push("redis"); },
        closePostgres: async () => { calls.push("postgres"); },
      },
      100,
      recordingLogger(calls),
    );

    const shutdown = coordinator.shutdown("SIGTERM");
    await Promise.resolve();
    expect(tracker.isShuttingDown()).toBeTrue();
    const readiness = new ReadinessService(
      async () => {},
      async () => {},
      20,
      () => tracker.isShuttingDown(),
    );
    expect(await readiness.check()).toEqual({ status: "not_ready" });
    expect(tracker.begin()).toBeNull();
    expect(calls).toContain("shutdown.started");
    expect(calls).not.toContain("redis");
    release?.();
    await shutdown;

    expect(calls).toEqual([
      "shutdown.started",
      "http:false",
      "redis",
      "postgres",
      "shutdown.completed",
    ]);
  });

  test("forces HTTP stop after the bounded grace period", async () => {
    const tracker = new InFlightRequestTracker();
    tracker.begin();
    const calls: string[] = [];
    const coordinator = new GracefulShutdownCoordinator(
      tracker,
      {
        stopHttp: (force) => { calls.push(`http:${force}`); },
        closeRedis: () => { calls.push("redis"); },
        closePostgres: () => { calls.push("postgres"); },
      },
      5,
      recordingLogger(calls),
    );

    await coordinator.shutdown("SIGINT");
    expect(calls).toContain("shutdown.grace_period_expired");
    expect(calls).toContain("http:true");
    expect(calls).toContain("redis");
    expect(calls).toContain("postgres");
  });

  test("continues teardown after close errors and is idempotent", async () => {
    const tracker = new InFlightRequestTracker();
    const calls: string[] = [];
    const coordinator = new GracefulShutdownCoordinator(
      tracker,
      {
        stopHttp: () => { calls.push("http"); },
        closeRedis: () => {
          calls.push("redis");
          throw new Error("redis credentials must not escape");
        },
        closePostgres: async () => {
          calls.push("postgres");
          throw new Error("database URL must not escape");
        },
      },
      20,
      recordingLogger(calls),
    );

    const first = coordinator.shutdown("SIGTERM");
    const second = coordinator.shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    expect(calls.filter((call) => call === "redis")).toHaveLength(1);
    expect(calls.filter((call) => call === "postgres")).toHaveLength(1);
    expect(calls.filter((call) => call === "shutdown.resource_close_failed")).toHaveLength(2);
  });

  test("bounds hanging resource closes and continues teardown", async () => {
    const tracker = new InFlightRequestTracker();
    const calls: string[] = [];
    const coordinator = new GracefulShutdownCoordinator(
      tracker,
      {
        stopHttp: () => {},
        closeRedis: () => new Promise<void>(() => {}),
        closePostgres: () => { calls.push("postgres"); },
      },
      20,
      recordingLogger(calls),
      5,
    );

    await coordinator.shutdown("SIGTERM");
    expect(calls).toContain("shutdown.resource_close_timed_out");
    expect(calls).toContain("postgres");
    expect(calls).toContain("shutdown.completed");
  });

  test("registers both process signals", () => {
    const listeners = new Map<string, () => void>();
    const signals: string[] = [];
    registerShutdownSignals(
      {
        on: (signal, listener) => listeners.set(signal, listener),
      },
      { shutdown: async (signal) => void signals.push(signal) },
    );
    listeners.get("SIGTERM")?.();
    listeners.get("SIGINT")?.();
    expect(signals).toEqual(["SIGTERM", "SIGINT"]);
  });
});
