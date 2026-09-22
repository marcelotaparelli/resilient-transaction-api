import { z } from "zod";
import {
  ProviderInvalidResponseError,
  ProviderNetworkError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  ProviderServerError,
  ProviderTimeoutError,
} from "../../application/errors/provider-errors";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../application/ports/payment-provider";
import type { TransactionInput } from "../../domain/transaction";
import type {
  ApplicationMetrics,
  ProviderFailureCategory,
} from "../observability/metrics";
import { currentRequestId } from "../observability/request-context";

const providerResponseSchema = z
  .object({
    providerTransactionId: z.string().min(1),
    decision: z.literal("approved"),
  })
  .strict();

export interface ScheduledTimeout {
  cancel(): void;
}

export interface TimeoutScheduler {
  schedule(callback: () => void, delayMs: number): ScheduledTimeout;
}

export class RuntimeTimeoutScheduler implements TimeoutScheduler {
  schedule(callback: () => void, delayMs: number): ScheduledTimeout {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  }
}

export type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class HttpPaymentProvider implements PaymentProvider {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly fetchRequest: FetchRequest = fetch,
    private readonly timeoutScheduler: TimeoutScheduler =
      new RuntimeTimeoutScheduler(),
    private readonly metrics?: ApplicationMetrics,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Provider timeout must be a positive safe integer");
    }
  }

  async process(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    this.metrics?.providerAttempt();
    const controller = new AbortController();
    const requestId = currentRequestId();
    const timeout = this.timeoutScheduler.schedule(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await this.fetchRequest(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(requestId === undefined ? {} : { "X-Request-Id": requestId }),
        },
        body: JSON.stringify(transaction),
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new ProviderRateLimitedError();
      }

      if (response.status >= 500) {
        throw new ProviderServerError(response.status);
      }

      if (!response.ok) {
        throw new ProviderRejectedError(response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderInvalidResponseError();
      }

      const parsed = providerResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ProviderInvalidResponseError();
      }

      return parsed.data;
    } catch (error: unknown) {
      if (
        error instanceof ProviderInvalidResponseError ||
        error instanceof ProviderRateLimitedError ||
        error instanceof ProviderRejectedError ||
        error instanceof ProviderServerError
      ) {
        this.metrics?.providerFailure(providerFailureCategory(error));
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        this.metrics?.providerTimeout();
        this.metrics?.providerFailure("timeout");
        throw new ProviderTimeoutError();
      }

      this.metrics?.providerFailure("network");
      throw new ProviderNetworkError();
    } finally {
      timeout.cancel();
    }
  }
}

function providerFailureCategory(error: unknown): ProviderFailureCategory {
  if (error instanceof ProviderRateLimitedError) return "rate_limited";
  if (error instanceof ProviderRejectedError) return "rejected";
  if (error instanceof ProviderServerError) return "server";
  if (error instanceof ProviderInvalidResponseError) return "invalid_response";
  return "unknown";
}
