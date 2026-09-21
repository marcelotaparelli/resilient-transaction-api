import type { RateLimiter } from "../application/ports/rate-limiter";
import type { CreateTransaction } from "../application/use-cases/create-transaction";
import type { GetTransaction } from "../application/use-cases/get-transaction";
import type { ListTransactions } from "../application/use-cases/list-transactions";
import { errorResponse, mapApplicationError } from "./error-response";
import { idempotencyKeySchema, transactionIdSchema } from "./schemas/header-schema";
import { paginationSchema } from "./schemas/pagination-schema";
import { transactionSchema } from "./schemas/transaction-schema";
import type {
  AuthenticatedService,
  ServiceAuthenticator,
} from "./security/service-authenticator";

const authorizationHeaderMaxLength = 512;
const bearerTokenPattern = /^Bearer ([A-Za-z0-9\-._~+/=]{32,256})$/i;

type ServerDependencies = {
  authenticator: ServiceAuthenticator;
  maxBodyBytes: number;
  createTransaction: Pick<CreateTransaction, "execute">;
  getTransaction: Pick<GetTransaction, "execute">;
  listTransactions: Pick<ListTransactions, "execute">;
  rateLimiter: RateLimiter;
};

export type HttpHandler = (request: Request) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function unauthorized(): Response {
  return errorResponse("UNAUTHORIZED", "Authentication required", 401, {
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

async function authenticate(
  request: Request,
  authenticator: ServiceAuthenticator,
): Promise<AuthenticatedService | Response> {
  const authorization = request.headers.get("Authorization");
  if (
    authorization === null ||
    authorization.length > authorizationHeaderMaxLength
  ) {
    return unauthorized();
  }

  const match = bearerTokenPattern.exec(authorization);
  const apiKey = match?.[1];
  if (apiKey === undefined) {
    return unauthorized();
  }

  const service = await authenticator.authenticate(apiKey);
  return service ?? unauthorized();
}

async function applyRateLimit(
  serviceId: string,
  rateLimiter: RateLimiter,
): Promise<Response | null> {
  const result = await rateLimiter.consume(serviceId);
  if (!result.allowed) {
    return errorResponse("RATE_LIMIT_EXCEEDED", "Too many requests", 429, {
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }

  return null;
}

function validateDeclaredBodySize(
  request: Request,
  maxBodyBytes: number,
): Response | null {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength === null) return null;
  if (!/^\d{1,15}$/.test(contentLength)) {
    return errorResponse(
      "INVALID_CONTENT_LENGTH",
      "Content-Length is invalid",
      400,
    );
  }

  const declaredBytes = Number(contentLength);
  if (!Number.isSafeInteger(declaredBytes)) {
    return errorResponse(
      "INVALID_CONTENT_LENGTH",
      "Content-Length is invalid",
      400,
    );
  }

  return declaredBytes > maxBodyBytes
    ? errorResponse(
        "PAYLOAD_TOO_LARGE",
        "Request body is too large",
        413,
      )
    : null;
}

function hasSupportedJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("Content-Type");
  if (contentType === null) return false;
  const parts = contentType.split(";").map((part) => part.trim().toLowerCase());
  return (
    parts[0] === "application/json" &&
    (parts.length === 1 ||
      (parts.length === 2 && parts[1] === "charset=utf-8"))
  );
}

type BodyResult =
  | { kind: "parsed"; value: unknown }
  | { kind: "invalid" }
  | { kind: "too_large" };

async function readBoundedJson(
  request: Request,
  maxBodyBytes: number,
): Promise<BodyResult> {
  if (request.body === null) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size decision is already final even if transport cancellation fails.
        }
        return { kind: "too_large" };
      }
      chunks.push(result.value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return { kind: "parsed", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

async function routeRequest(
  request: Request,
  dependencies: ServerDependencies,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/health/live")
  ) {
    return json({ status: "ok" });
  }

  const isList = request.method === "GET" && url.pathname === "/transactions";
  const transactionByIdMatch = /^\/transactions\/([^/]+)$/.exec(url.pathname);
  const isGetById = request.method === "GET" && transactionByIdMatch !== null;
  const isCreate = request.method === "POST" && url.pathname === "/transactions";

  if (!isList && !isGetById && !isCreate) {
    return errorResponse("NOT_FOUND", "Route not found", 404);
  }

  if (isCreate) {
    const sizeResponse = validateDeclaredBodySize(
      request,
      dependencies.maxBodyBytes,
    );
    if (sizeResponse !== null) return sizeResponse;
  }

  const authentication = await authenticate(request, dependencies.authenticator);
  if (authentication instanceof Response) return authentication;
  const rateLimitResponse = await applyRateLimit(
    authentication.id,
    dependencies.rateLimiter,
  );
  if (rateLimitResponse !== null) return rateLimitResponse;

  if (isList) {
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

  if (isGetById && transactionByIdMatch !== null) {
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

  if (isCreate) {
    if (!hasSupportedJsonContentType(request)) {
      return errorResponse(
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json",
        415,
      );
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

    const body = await readBoundedJson(request, dependencies.maxBodyBytes);
    if (body.kind === "too_large") {
      return errorResponse(
        "PAYLOAD_TOO_LARGE",
        "Request body is too large",
        413,
      );
    }
    if (body.kind === "invalid") {
      return errorResponse("INVALID_JSON", "Request body is not valid JSON", 400);
    }

    const parsedTransaction = transactionSchema.safeParse(body.value);
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
