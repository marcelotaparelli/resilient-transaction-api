import type { OperationalLogger } from "../observability/logger";

export class InFlightRequestTracker {
  private active = 0;
  private shuttingDown = false;
  private readonly drainWaiters = new Set<() => void>();

  begin(): (() => void) | null {
    if (this.shuttingDown) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (this.active === 0) {
        for (const waiter of this.drainWaiters) waiter();
        this.drainWaiters.clear();
      }
    };
  }

  startShutdown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  activeRequests(): number {
    return this.active;
  }

  async waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.drainWaiters.delete(onDrain);
        resolve(drained);
      };
      const onDrain = (): void => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.drainWaiters.add(onDrain);
    });
  }
}

export type ShutdownResources = {
  stopHttp(force: boolean): void | Promise<void>;
  closeRedis(): void | Promise<void>;
  closePostgres(): void | Promise<void>;
};

export class GracefulShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly tracker: InFlightRequestTracker,
    private readonly resources: ShutdownResources,
    private readonly gracePeriodMs: number,
    private readonly logger: OperationalLogger,
    private readonly resourceCloseTimeoutMs = 1_000,
  ) {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 1) {
      throw new Error("Shutdown grace period must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(resourceCloseTimeoutMs) ||
      resourceCloseTimeoutMs < 1
    ) {
      throw new Error("Resource close timeout must be a positive safe integer");
    }
  }

  shutdown(signal: string): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown(signal);
    return this.shutdownPromise;
  }

  private async performShutdown(signal: string): Promise<void> {
    this.tracker.startShutdown();
    this.logger.log("info", "shutdown.started", {
      signal,
      activeRequests: this.tracker.activeRequests(),
      gracePeriodMs: this.gracePeriodMs,
    });

    const gracefulHttpStop = this.safeCall(
      "http_stop",
      () => this.resources.stopHttp(false),
      this.gracePeriodMs,
    );
    const drained = await this.tracker.waitForDrain(this.gracePeriodMs);
    if (!drained) {
      this.logger.log("warn", "shutdown.grace_period_expired", {
        activeRequests: this.tracker.activeRequests(),
      });
      await this.safeCall("http_force_stop", () => this.resources.stopHttp(true));
    } else {
      await gracefulHttpStop;
    }

    await this.safeCall("redis_close", () => this.resources.closeRedis());
    await this.safeCall("postgres_close", () => this.resources.closePostgres());
    this.logger.log("info", "shutdown.completed", {
      activeRequests: this.tracker.activeRequests(),
    });
  }

  private async safeCall(
    operation: string,
    action: () => void | Promise<void>,
    timeoutMs = this.resourceCloseTimeoutMs,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = Promise.resolve()
      .then(action)
      .then(
        () => "completed" as const,
        () => "failed" as const,
      );
    const deadline = new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    });
    const result = await Promise.race([completed, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);

    if (result === "failed") {
      this.logger.log("error", "shutdown.resource_close_failed", { operation });
    } else if (result === "timed_out") {
      this.logger.log("error", "shutdown.resource_close_timed_out", {
        operation,
      });
    }
  }
}

export interface SignalSource {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function registerShutdownSignals(
  signalSource: SignalSource,
  coordinator: Pick<GracefulShutdownCoordinator, "shutdown">,
): void {
  const register = (signal: "SIGTERM" | "SIGINT"): void => {
    signalSource.on(signal, () => {
      void coordinator.shutdown(signal);
    });
  };
  register("SIGTERM");
  register("SIGINT");
}
