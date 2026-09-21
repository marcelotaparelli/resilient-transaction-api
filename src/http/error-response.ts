import {
  ProviderInvalidResponseError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../application/errors/provider-errors";
import { TransactionNotFoundError } from "../application/errors/transaction-not-found-error";

type ErrorResponseOptions = {
  details?: unknown;
  headers?: HeadersInit;
};

export function errorResponse(
  code: string,
  message: string,
  status: number,
  options: ErrorResponseOptions = {},
): Response {
  const error =
    options.details === undefined
      ? { code, message }
      : { code, message, details: options.details };
  const init: ResponseInit =
    options.headers === undefined
      ? { status }
      : { status, headers: options.headers };

  return Response.json({ error }, init);
}

export function mapApplicationError(error: unknown): Response {
  if (error instanceof TransactionNotFoundError) {
    return errorResponse(
      "TRANSACTION_NOT_FOUND",
      "Transaction not found",
      404,
    );
  }

  if (error instanceof ProviderTimeoutError) {
    return errorResponse("PROVIDER_TIMEOUT", "Payment provider timed out", 504);
  }

  if (error instanceof ProviderUnavailableError) {
    return errorResponse(
      "PROVIDER_UNAVAILABLE",
      "Payment provider is unavailable",
      503,
    );
  }

  if (error instanceof ProviderInvalidResponseError) {
    return errorResponse(
      "PROVIDER_INVALID_RESPONSE",
      "Payment provider returned an invalid response",
      502,
    );
  }

  if (error instanceof ProviderRejectedError) {
    return errorResponse(
      "PROVIDER_REJECTED",
      "Payment provider rejected the transaction",
      502,
    );
  }

  return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
}
