# ADR 0004: Service authentication and HTTP boundaries

## Status

Accepted.

## Context

Business routes previously used caller-controlled `X-Client-Id` as the rate-limit subject and had no authentication. POST parsed the complete body before applying a byte boundary. Those behaviors allowed identity spoofing and unnecessary resource consumption.

The API is service-to-service. It does not need users, sessions, OAuth, JWT, or a broad authorization model in this phase.

## Decision

`POST /transactions`, `GET /transactions/:id`, and `GET /transactions` require `Authorization: Bearer <api-key>`. Configuration maps a stable `serviceId` to the SHA-256 digest of a high-entropy API key. The raw key is supplied to the calling service through secret management outside this repository and is never stored in source or passed beyond the authenticator.

The authenticator hashes the presented key and compares fixed-length digests with `timingSafeEqual`. It checks every configured credential instead of returning at the first comparison. This reduces simple content-dependent comparison timing; it is not a claim of complete timing-attack resistance. SHA-256 is appropriate here because the credentials are randomly generated, high-entropy API keys. It would not be sufficient password storage for low-entropy human passwords.

The resulting `serviceId`, rather than the secret or `X-Client-Id`, is the Redis rate-limit subject. Service IDs are bounded and validated at startup, and the Redis adapter encodes them when building keys. `X-Client-Id` is ignored and retained only as an inert compatibility header during transition.

`GET /health` and `GET /health/live` remain unauthenticated so process probes do not depend on credentials. A full readiness endpoint is still deferred to the operations phase; the API does not expose a misleading readiness result in this phase.

POST bodies are limited to 16 KiB by default. A valid declared `Content-Length` is rejected early when over the limit, and the body stream independently enforces the same boundary so a missing or false header cannot bypass it. POST accepts `application/json` and `application/json; charset=utf-8`; unsupported or missing media types return 415. Malformed JSON returns 400 and oversized bodies return 413.

Known application errors retain explicit public mappings. Unexpected errors always return the same `INTERNAL_ERROR` envelope. A small centralized redactor covers authorization, API keys, credentials, database/Redis URLs, secrets, idempotency keys, and full bodies/payloads before structured fields reach current operational logging.

## Consequences

Authentication is local to each API process and credential rotation requires overlapping configured hashes plus an application configuration rollout. Credentials are static service secrets; there is no expiry, per-route role model, revocation service, or audit trail yet.

Redis failure may disable rate limiting temporarily, but it never bypasses authentication because authentication runs first and does not depend on Redis. Cache lookup also runs only after authentication. Health endpoints intentionally reveal only `{ "status": "ok" }`.
