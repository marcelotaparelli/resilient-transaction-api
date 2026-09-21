import type { Clock } from "../../application/ports/clock";

export type CircuitState = "closed" | "open" | "half_open";

export type CircuitPermit = {
  mode: "closed" | "half_open";
  generation: number;
};

export type CircuitBreakerConfig = {
  failureThreshold: number;
  openDurationMs: number;
};

export function validateCircuitBreakerConfig(
  config: CircuitBreakerConfig,
): void {
  if (
    !Number.isSafeInteger(config.failureThreshold) ||
    config.failureThreshold < 1
  ) {
    throw new Error("failureThreshold must be a positive safe integer");
  }

  if (
    !Number.isSafeInteger(config.openDurationMs) ||
    config.openDurationMs < 1
  ) {
    throw new Error("openDurationMs must be a positive safe integer");
  }
}

export class CircuitBreaker {
  private currentState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private halfOpenProbeInFlight = false;
  private generation = 0;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
  ) {
    validateCircuitBreakerConfig(config);
  }

  state(): CircuitState {
    this.advanceToHalfOpenWhenReady();
    return this.currentState;
  }

  acquire(): CircuitPermit | null {
    this.advanceToHalfOpenWhenReady();

    if (this.currentState === "open") {
      return null;
    }

    if (this.currentState === "half_open") {
      if (this.halfOpenProbeInFlight) {
        return null;
      }

      this.halfOpenProbeInFlight = true;
      return { mode: "half_open", generation: this.generation };
    }

    return { mode: "closed", generation: this.generation };
  }

  recordSuccess(permit: CircuitPermit): void {
    if (!this.isCurrent(permit)) {
      return;
    }

    if (permit.mode === "half_open") {
      this.close();
      return;
    }

    if (this.currentState === "closed") {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(permit: CircuitPermit): void {
    if (!this.isCurrent(permit)) {
      return;
    }

    if (permit.mode === "half_open") {
      this.open();
      return;
    }

    if (this.currentState !== "closed") {
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.open();
    }
  }

  recordNonFailure(permit: CircuitPermit): void {
    if (!this.isCurrent(permit)) {
      return;
    }

    if (permit.mode === "half_open") {
      this.close();
    }
  }

  private advanceToHalfOpenWhenReady(): void {
    if (
      this.currentState === "open" &&
      this.clock.now().getTime() - this.openedAtMs >=
        this.config.openDurationMs
    ) {
      this.currentState = "half_open";
      this.halfOpenProbeInFlight = false;
    }
  }

  private isCurrent(permit: CircuitPermit): boolean {
    return permit.generation === this.generation;
  }

  private open(): void {
    this.currentState = "open";
    this.openedAtMs = this.clock.now().getTime();
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
    this.generation += 1;
  }

  private close(): void {
    this.currentState = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
    this.generation += 1;
  }
}
