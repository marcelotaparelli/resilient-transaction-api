import { describe, expect, test } from "bun:test";
import { ApplicationMetrics } from "../../src/infrastructure/observability/metrics";
import { ReadinessService } from "../../src/infrastructure/operability/readiness";

describe("ReadinessService", () => {
  test("is ready when PostgreSQL and Redis probes succeed", async () => {
    const readiness = new ReadinessService(
      async () => {},
      async () => {},
      20,
      () => false,
    );
    expect(await readiness.check()).toEqual({ status: "ready" });
  });

  test("is degraded but ready for traffic when only Redis fails", async () => {
    const metrics = new ApplicationMetrics();
    const readiness = new ReadinessService(
      async () => {},
      async () => {
        throw new Error("redis://secret@private-host");
      },
      20,
      () => false,
      metrics,
    );
    expect(await readiness.check()).toEqual({ status: "degraded" });
    expect(metrics.value("redis_errors_total", { operation: "readiness" })).toBe(1);
  });

  test("is not ready when PostgreSQL fails and does not expose the error", async () => {
    const metrics = new ApplicationMetrics();
    const readiness = new ReadinessService(
      async () => {
        throw new Error("postgres://admin:secret@private-host/database");
      },
      async () => {},
      20,
      () => false,
      metrics,
    );
    expect(await readiness.check()).toEqual({ status: "not_ready" });
    expect(metrics.value("database_errors_total", { operation: "readiness" })).toBe(1);
  });

  test("bounds a hanging critical probe", async () => {
    const startedAt = performance.now();
    const readiness = new ReadinessService(
      () => new Promise<void>(() => {}),
      async () => {},
      5,
      () => false,
    );
    expect(await readiness.check()).toEqual({ status: "not_ready" });
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("becomes not ready immediately during shutdown", async () => {
    let postgresCalls = 0;
    const readiness = new ReadinessService(
      async () => {
        postgresCalls += 1;
      },
      async () => {},
      20,
      () => true,
    );
    expect(await readiness.check()).toEqual({ status: "not_ready" });
    expect(postgresCalls).toBe(0);
  });
});
