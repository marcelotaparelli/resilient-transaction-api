# ADR 0005: Local observability and process lifecycle

## Status

Accepted.

## Context

The service needs enough operational evidence to correlate failures, distinguish critical from optional dependency outages, and terminate predictably. This phase does not introduce a metrics collector, log shipper, tracing system, or cloud runtime.

## Decision

Every HTTP request receives a UUID request ID. A valid caller-provided UUID in `X-Request-Id` is preserved; absent, malformed, or oversized values are replaced with a generated UUID. The ID is returned in the response header and every public error envelope. It is held in `AsyncLocalStorage` for operational correlation and propagated to the provider as `X-Request-Id`. It never replaces `Idempotency-Key` and does not enter domain entities.

Logs are one JSON object per line. A small logger accepts an allowlist of bounded operational fields such as request ID, route template, method, status, duration, public error code, attempt, and operation. Authenticated service IDs are deliberately omitted because they are not needed for the selected operational events. The logger never serializes Request, headers, bodies, errors, or configuration. INFO covers normal completion and state recovery, WARN covers expected degradation, retry, authentication failure, rate rejection and breaker opening, and ERROR covers unexpected HTTP failures, critical database readiness failure and teardown failures. HTTP duration uses the monotonic `performance.now()` clock; timestamps use wall clock.

Metrics are maintained in memory per process and exposed publicly at `GET /metrics` using Prometheus text format. Restarting the process resets counters. HTTP latency uses fixed cumulative buckets from 5 ms through 10 s. Labels are restricted to method, route template, status/status class, bounded failure category, operation, and histogram boundary. Values outside the HTTP method and route allowlists are normalized to fixed fallbacks. Request IDs, service IDs, transaction IDs, idempotency keys, raw paths, messages, URLs, and exception types are prohibited as labels.

`http_errors_total` counts both 4xx and 5xx responses and separates them with a `class` label. `provider_requests_total` counts actual external HTTP attempts. Provider retry, timeout, failure, circuit opening, cache, rate-limit rejection, Redis readiness/operation errors, and PostgreSQL readiness errors use separate counters.

`GET /health/live` checks only that the HTTP process can answer. `GET /health/ready` runs bounded `SELECT 1` and Redis `PING` probes. PostgreSQL failure returns HTTP 503 `not_ready`. Redis failure returns HTTP 200 `degraded` because cache and rate limiting already have explicit fail-open behavior. The provider is excluded because retry and the local circuit breaker handle its availability without making the instance unable to serve all useful traffic.

Startup validates all configuration and requires PostgreSQL readiness before listening. Redis may start degraded. Each dependency probe has a 500 ms deadline by default.

SIGTERM and SIGINT share an idempotent shutdown coordinator. It marks readiness false and blocks new business work, asks Bun to stop accepting connections, waits for tracked requests, force-stops HTTP after the grace period, then closes Redis and PostgreSQL. Resource-close failures and timeouts are logged safely and do not prevent later teardown steps. The default 15-second grace period exceeds the configured maximum provider execution window of 12.8 seconds by 2.2 seconds, and startup rejects a shorter value. Force-close, Redis close, and PostgreSQL close each have a separate 1-second deadline, bounding the default coordinator path to approximately 18 seconds.

## Consequences

Metrics and breaker state remain local to each replica and reset at restart. Logs require an external runtime to collect them later. Readiness timeouts bound the caller's wait but cannot guarantee cancellation of a database command already sent. Forced shutdown after the grace period can interrupt unfinished work; PostgreSQL idempotency state and provider idempotency remain the recovery mechanisms. The design provides bounded drain, not lossless shutdown or zero downtime.
