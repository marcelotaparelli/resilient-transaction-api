import { z } from "zod";
import {
  ProviderInvalidResponseError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../application/errors/provider-errors";
import type {
  PaymentProvider,
  ProviderResult,
} from "../../application/ports/payment-provider";
import type { TransactionInput } from "../../domain/transaction";

const providerResponseSchema = z.object({
  providerTransactionId: z.string().min(1),
  decision: z.literal("approved"),
}).strict();

export class HttpPaymentProvider implements PaymentProvider {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly maxAttempts: number,
    private readonly baseDelayMs: number,
  ) {}

  async process(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.processAttempt(transaction, idempotencyKey);
      } catch (error: unknown) {
        const retryable =
          error instanceof ProviderTimeoutError ||
          error instanceof ProviderUnavailableError;

        if (!retryable || attempt === this.maxAttempts) {
          throw error;
        }

        const delay = this.baseDelayMs * 2 ** (attempt - 1);
        await Bun.sleep(delay);
      }
    }

    throw new ProviderUnavailableError();
  }

  private async processAttempt(
    transaction: TransactionInput,
    idempotencyKey: string,
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(transaction),
        signal: controller.signal,
      });

      if (response.status >= 500) {
        throw new ProviderUnavailableError();
      }

      if (!response.ok) {
        throw new ProviderRejectedError();
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
        error instanceof ProviderRejectedError ||
        error instanceof ProviderUnavailableError
      ) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderTimeoutError();
      }

      throw new ProviderUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}
