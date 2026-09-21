import type { RateLimiter } from "../application/ports/rate-limiter";
import type { CreateTransaction } from "../application/use-cases/create-transaction";
import type { GetTransaction } from "../application/use-cases/get-transaction";
import type { ListTransactions } from "../application/use-cases/list-transactions";
import { errorResponse, mapApplicationError } from "./error-response";
import {
  clientIdSchema,
  idempotencyKeySchema,
  transactionIdSchema,
} from "./schemas/header-schema";
import { paginationSchema } from "./schemas/pagination-schema";
import { transactionSchema } from "./schemas/transaction-schema";

type ServerDependencies = {
  createTransaction: Pick<CreateTransaction, "execute">;
  getTransaction: Pick<GetTransaction, "execute">;
  listTransactions: Pick<ListTransactions, "execute">;
  rateLimiter: RateLimiter;
};

export type HttpHandler = (request: Request) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function applyRateLimit(
  request: Request,
  rateLimiter: RateLimiter,
): Promise<Response | null> {
  const rawClientId = request.headers.get("X-Client-Id");
  if (rawClientId === null) {
    return errorResponse("MISSING_CLIENT_ID", "X-Client-Id is required", 400);
  }

  const parsedClientId = clientIdSchema.safeParse(rawClientId);
  if (!parsedClientId.success) {
    return errorResponse("INVALID_CLIENT_ID", "X-Client-Id is invalid", 400);
  }

  const result = await rateLimiter.consume(parsedClientId.data);
  if (!result.allowed) {
    return errorResponse("RATE_LIMIT_EXCEEDED", "Too many requests", 429, {
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }

  return null;
}

async function routeRequest(
  request: Request,
  dependencies: ServerDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/transactions") {
    const rateLimitResponse = await applyRateLimit(
      request,
      dependencies.rateLimiter,
    );
    if (rateLimitResponse !== null) {
      return rateLimitResponse;
    }

    const parsedPagination = paginationSchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );

    if (!parsedPagination.success) {
      return errorResponse("INVALID_PAGINATION", "Pagination is invalid", 400, {
        details: { issues: parsedPagination.error.issues },
      });
    }

    const result = await dependencies.listTransactions.execute(
      parsedPagination.data.page,
      parsedPagination.data.limit,
    );
    return json(result);
  }

  const transactionByIdMatch = /^\/transactions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && transactionByIdMatch !== null) {
    const rateLimitResponse = await applyRateLimit(
      request,
      dependencies.rateLimiter,
    );
    if (rateLimitResponse !== null) {
      return rateLimitResponse;
    }

    const parsedTransactionId = transactionIdSchema.safeParse(
      transactionByIdMatch[1],
    );
    if (!parsedTransactionId.success) {
      return errorResponse(
        "INVALID_TRANSACTION_ID",
        "Transaction ID is invalid",
        400,
      );
    }

    const transaction = await dependencies.getTransaction.execute(
      parsedTransactionId.data,
    );
    return json(transaction);
  }

  if (request.method === "POST" && url.pathname === "/transactions") {
    const rateLimitResponse = await applyRateLimit(
      request,
      dependencies.rateLimiter,
    );
    if (rateLimitResponse !== null) {
      return rateLimitResponse;
    }

    const rawIdempotencyKey = request.headers.get("Idempotency-Key");
    if (rawIdempotencyKey === null) {
      return errorResponse(
        "MISSING_IDEMPOTENCY_KEY",
        "Idempotency-Key is required",
        400,
      );
    }

    const parsedIdempotencyKey = idempotencyKeySchema.safeParse(
      rawIdempotencyKey,
    );
    if (!parsedIdempotencyKey.success) {
      return errorResponse(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key is invalid",
        400,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_JSON", "Request body is not valid JSON", 400);
    }

    const parsedTransaction = transactionSchema.safeParse(body);
    if (!parsedTransaction.success) {
      return errorResponse(
        "INVALID_TRANSACTION",
        "Transaction is invalid",
        422,
        { details: { issues: parsedTransaction.error.issues } },
      );
    }

    const result = await dependencies.createTransaction.execute(
      parsedTransaction.data,
      parsedIdempotencyKey.data,
    );
    return json(result.transaction, result.created ? 201 : 200);
  }

  return errorResponse("NOT_FOUND", "Route not found", 404);
}

export function createHttpHandler(
  dependencies: ServerDependencies,
): HttpHandler {
  return async (request: Request): Promise<Response> => {
    try {
      return await routeRequest(request, dependencies);
    } catch (error: unknown) {
      return mapApplicationError(error);
    }
  };
}

export function startServer(
  handler: HttpHandler,
  port = 4002,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({ port, fetch: handler });
}
