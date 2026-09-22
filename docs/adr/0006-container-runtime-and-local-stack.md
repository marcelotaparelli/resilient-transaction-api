# ADR 0006: Container runtime and local stack

## Status

Accepted.

## Context

The API already has a bounded HTTP lifecycle, explicit migrations, PostgreSQL as the source of truth, Redis as a degradable dependency, and a fake provider for local tests. Containerization must package those decisions without introducing a process manager or changing application semantics.

## Decision

The image pins `oven/bun:1.4.2-slim`, matching the Bun toolchain used by the repository. The Dockerfile uses frozen lockfile installs and separate production-dependency, runtime, provider and quality stages. The runtime executes TypeScript directly with JSON-form `CMD ["bun", "src/main.ts"]` as the supplied non-root `bun` user. There is no bundling, supervisor, shell wrapper, or runtime write directory. The provider has a separate target for local Compose only.

The runtime image copies only production `node_modules`, package metadata, source needed by the API, and migrations. `.dockerignore` removes repository metadata, local dependencies, environments, reports, logs, temporary files and editor state. No credential is copied into an image layer.

Compose uses explicit PostgreSQL 15.19 and Redis 7.2.16 images. PostgreSQL has a named volume and is required to be healthy before the one-shot migration service runs. The API depends on migration completion and publishes only its HTTP port. Redis is on the private Compose network without a volume; its data is disposable by design. The fake provider is a separate local service because the project already owns that executable; this does not imply a production microservice split.

The API receives service credentials and connection URLs through environment variables. Service-to-service traffic uses Compose DNS names (`postgres`, `redis`, `provider`) rather than localhost. The default Compose credential and database password are development-only placeholders and must be overridden outside local smoke tests.

The image healthcheck uses Bun's native fetch with a one-second AbortController deadline against `/health/ready`. It does not add curl or wget. Readiness therefore follows application policy: PostgreSQL failure is unhealthy, Redis failure is HTTP 200 degraded. `docker compose stop -t 20 api` gives the application’s 15-second shutdown grace period room to drain before a forced stop.

## Consequences

Builds require access to the Bun and service image registries; this environment does not provide a Docker daemon, so image execution is validated by static runtime-contract tests and documented for execution on a Docker-enabled host. The final image remains larger than a specialized distroless image in exchange for Bun compatibility and straightforward debugging. Compose is a local reproducibility tool, not AWS infrastructure or a deployment workflow.
