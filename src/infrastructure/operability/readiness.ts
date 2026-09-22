import type { ApplicationMetrics } from "../observability/metrics";
import type { OperationalLogger } from "../observability/logger";
import { noOpLogger } from "../observability/logger";

export type ReadinessResult =
  | { status: "ready" }
  | { status: "degraded" }
  | { status: "not_ready" };

export type DependencyProbe = () => Promise<void>;

export class ReadinessService {
  constructor(
    private readonly postgresProbe: DependencyProbe,
    private readonly redisProbe: DependencyProbe,
    private readonly timeoutMs: number,
    private readonly isShuttingDown: () => boolean,
    private readonly metrics?: ApplicationMetrics,
    private readonly logger: OperationalLogger = noOpLogger,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Readiness timeout must be a positive safe integer");
    }
  }

  async check(): Promise<ReadinessResult> {
    if (this.isShuttingDown()) return { status: "not_ready" };

    const postgresReady = await this.probe(this.postgresProbe);
    if (!postgresReady) {
      this.metrics?.databaseError("readiness");
      this.logger.log("error", "database.error", { operation: "readiness" });
      return { status: "not_ready" };
    }

    const redisReady = await this.probe(this.redisProbe);
    if (!redisReady) {
      this.metrics?.redisError("readiness");
      this.logger.log("warn", "redis.error", { operation: "readiness" });
      return { status: "degraded" };
    }

    return { status: "ready" };
  }

  private async probe(probe: DependencyProbe): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.timeoutMs);
    });
    try {
      return await Promise.race([
        probe().then(
          () => true,
          () => false,
        ),
        deadline,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
