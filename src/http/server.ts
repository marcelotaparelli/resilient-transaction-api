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
import type { OperationalLogger } from "../infrastructure/observability/logger";
import { noOpLogger } from "../infrastructure/observability/logger";
import type { ApplicationMetrics } from "../infrastructure/observability/metrics";
import { runWithRequestContext } from "../infrastructure/observability/request-context";
import type { InFlightRequestTracker } from "../infrastructure/operability/lifecycle";
import type {
  ReadinessResult,
  ReadinessService,
} from "../infrastructure/operability/readiness";

const authorizationHeaderMaxLength = 512;
const bearerTokenPattern = /^Bearer ([A-Za-z0-9\-._~+/=]{32,256})$/i;
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ServerDependencies = {
  authenticator: ServiceAuthenticator;
  maxBodyBytes: number;
  createTransaction: Pick<CreateTransaction, "execute">;
  getTransaction: Pick<GetTransaction, "execute">;
  listTransactions: Pick<ListTransactions, "execute">;
  rateLimiter: RateLimiter;
  logger?: OperationalLogger;
  metrics?: ApplicationMetrics;
  readiness?: Pick<ReadinessService, "check">;
  requestTracker?: InFlightRequestTracker;
  requestIdGenerator?: () => string;
  monotonicNow?: () => number;
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
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/health/live")
  ) {
    return json({ status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/health/ready") {
    if (dependencies.readiness === undefined) {
      return errorResponse("NOT_READY", "Service is not ready", 503);
    }
    const readiness: ReadinessResult = await dependencies.readiness.check();
    return json(readiness, readiness.status === "not_ready" ? 503 : 200);
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    return new Response(dependencies.metrics?.render() ?? "", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      },
    });
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
  if (authentication instanceof Response) {
    dependencies.logger?.log("warn", "auth.failed", {
      requestId,
      method: request.method,
      route: routeTemplate(request),
    });
    return authentication;
  }
  const rateLimitResponse = await applyRateLimit(
    authentication.id,
    dependencies.rateLimiter,
  );
  if (rateLimitResponse !== null) {
    dependencies.logger?.log("warn", "rate_limit.rejected", {
      requestId,
      method: request.method,
      route: routeTemplate(request),
    });
    return rateLimitResponse;
  }

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

function routeTemplate(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (/^\/transactions\/[^/]+$/.test(pathname)) return "/transactions/:id";
  if (
    pathname === "/transactions" ||
    pathname === "/health" ||
    pathname === "/health/live" ||
    pathname === "/health/ready" ||
    pathname === "/metrics"
  ) {
    return pathname;
  }
  return "unmatched";
}

function requestIdFrom(request: Request, generator: () => string): string {
  const supplied = request.headers.get("X-Request-Id");
  if (supplied !== null && requestIdPattern.test(supplied)) return supplied;

  const generated = generator();
  return requestIdPattern.test(generated) ? generated : crypto.randomUUID();
}

async function attachRequestId(
  response: Response,
  requestId: string,
): Promise<{ response: Response; errorCode?: string }> {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  if (response.status < 400) {
    return {
      response: new Response(response.body, { status: response.status, headers }),
    };
  }

  try {
    const text = await response.text();
    const body = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    if (
      body.error !== undefined &&
      typeof body.error.code === "string" &&
      typeof body.error.message === "string"
    ) {
      const error =
        body.error.details === undefined
          ? { ...body.error, requestId }
          : { ...body.error, requestId, details: body.error.details };
      return {
        response: Response.json(
          { error },
          { status: response.status, headers },
        ),
        errorCode: body.error.code,
      };
    }
    return {
      response: new Response(text, { status: response.status, headers }),
    };
  } catch {
    // Every current HTTP error uses the safe JSON envelope; keep a safe fallback.
  }

  return {
    response: new Response(null, { status: response.status, headers }),
  };
}

export function createHttpHandler(
  dependencies: ServerDependencies,
): HttpHandler {
  return async (request: Request): Promise<Response> => {
    const logger = dependencies.logger ?? noOpLogger;
    const requestId = requestIdFrom(
      request,
      dependencies.requestIdGenerator ?? (() => crypto.randomUUID()),
    );
    const route = routeTemplate(request);
    const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();

    const execute = async (): Promise<Response> => {
      let release: (() => void) | null = null;
      const operationalRoute =
        route === "/health" ||
        route === "/health/live" ||
        route === "/health/ready" ||
        route === "/metrics";
      if (dependencies.requestTracker !== undefined) {
        release = dependencies.requestTracker.begin();
        if (release === null && !operationalRoute) {
          return errorResponse(
            "SERVICE_UNAVAILABLE",
            "Service is shutting down",
            503,
          );
        }
      }

      try {
        return await routeRequest(request, dependencies, requestId);
      } catch (error: unknown) {
        return mapApplicationError(error);
      } finally {
        release?.();
      }
    };

    const rawResponse = await runWithRequestContext({ requestId }, execute);
    const finalized = await attachRequestId(rawResponse, requestId);
    const durationMs = Math.max(0, monotonicNow() - startedAt);
    dependencies.metrics?.recordHttp(
      request.method,
      route,
      finalized.response.status,
      durationMs / 1_000,
    );
    const fields = {
      requestId,
      method: request.method,
      route,
      status: finalized.response.status,
      durationMs,
      ...(finalized.errorCode === undefined
        ? {}
        : { errorCode: finalized.errorCode }),
    };
    logger.log(
      finalized.response.status >= 500 ? "error" : "info",
      finalized.response.status >= 500
        ? "http.request.failed"
        : "http.request.completed",
      fields,
    );
    if (finalized.errorCode === "IDEMPOTENCY_KEY_CONFLICT") {
      logger.log("warn", "idempotency.conflict", { requestId });
    } else if (
      finalized.errorCode === "IDEMPOTENCY_OPERATION_IN_PROGRESS"
    ) {
      logger.log("info", "idempotency.processing", { requestId });
    }
    return finalized.response;
  };
}

export function startServer(
  handler: HttpHandler,
  port = 4002,
  hostname = "0.0.0.0",
): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname, port, fetch: handler });
}
