# Phase 7V container runtime validation — progress

Date: 2026-09-22

## Validated

- Docker Engine 20.10.24 and Docker Compose 1.29.2 were installed for the validation environment.
- The Docker daemon runs with `fuse-overlayfs`; the initial `vfs` attempt exhausted the host filesystem while pulling PostgreSQL.
- The API and provider images build successfully from the committed Dockerfile.
- `bun install --frozen-lockfile --production` completed and installed only the runtime dependency (`zod`).
- The SHA-256 of `bun.lock` remained `3f14f57a8fc44877da93c71501375c89c31d39b33a0f0108dc7870de5d56ecc2` before and after the build.
- The API image contains Bun 1.4.2 and has an approximate size of 173,546,549 bytes (165.5 MiB).
- The configured runtime user is `bun` (UID/GID 1000), the working directory is `/app`, and the direct command is `bun src/main.ts`.
- Image inspection found the application source, migration, package metadata and production `node_modules`; it did not find tests, `.env`, Git metadata, coverage or agent session files.
- Compose started PostgreSQL 15.19, Redis 7.2.16, the fake provider, the one-shot migration job and the API.
- PostgreSQL and Redis reached healthy state.
- The migration job exited successfully with status 0 before the API was created.
- The API reached Docker health status `healthy`.
- Bun is PID 1 in the API container and runs as UID/GID 1000.
- The API container runs with a read-only root filesystem, all capabilities dropped and `no-new-privileges` enabled.
- Only the API port 4002 is published to the host; PostgreSQL and Redis remain private to the Compose network.

## Environment adjustment

The validation host initially lacked Docker. Its nested filesystem does not support Docker `overlay2`; the fallback `vfs` driver duplicated layers and exhausted the small root filesystem during the PostgreSQL pull. The daemon was restarted with `fuse-overlayfs` and a temporary data root under `/workspace/.docker-runtime`. This is validation infrastructure and is not an application change.

## Still pending

- HTTP liveness/readiness response inspection from the host (the host image has no `curl`; use Bun or another existing client).
- Authenticated POST and GET/cache behavior.
- Metrics and structured-log inspection.
- API restart persistence.
- Redis and PostgreSQL outage behavior and recovery.
- Real in-flight SIGTERM/graceful shutdown timing.
- Full portable, PostgreSQL and Redis test suites against the running dependencies.

