# ADR 0001: Use Bun.SQL for PostgreSQL

- Status: Accepted
- Date: 2026-09-21

## Context

The PostgreSQL adapter needs parameterized queries, connection pooling, transactions, migration execution and clean connection shutdown. The project already uses Bun as its runtime and should not add a database library without a concrete gap.

## Decision

Use the PostgreSQL client built into Bun 1.4 through `Bun.SQL`/`SQL` inside the infrastructure and composition layers.

The installed client provides:

- tagged template parameters;
- PostgreSQL connection pooling;
- `begin()` with commit and rollback;
- multi-statement SQL file execution;
- explicit `close()`;
- typed query results.

No ORM, query builder or third-party PostgreSQL driver is required for the current repository, migration and concurrency requirements.

## Consequences

There is no new runtime dependency or ORM abstraction. SQL remains explicit and reviewable. Bun-specific types stay inside Infrastructure and `main.ts`; Domain and Application remain runtime-independent.

The PostgreSQL adapter itself is coupled to Bun. If a future Node.js runtime requirement becomes concrete, this adapter can be replaced behind `TransactionRepository` or the decision can be revisited based on measured migration cost.
