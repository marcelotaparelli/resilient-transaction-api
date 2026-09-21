# ADR 0003: Redis for distributed rate limiting and transaction cache

## Status

Accepted.

## Context

O limiter in-memory não compartilha contadores entre réplicas. `GET /transactions/:id` consulta PostgreSQL mesmo para transações finais e imutáveis acessadas repetidamente. Nenhum desses problemas deve alterar a garantia de idempotência, cuja source of truth continua sendo PostgreSQL.

O Bun 1.4.2 oferece `Bun.RedisClient` com comandos raw, `EVAL`, connection timeout, reconnect configurável e fechamento explícito. Isso cobre os comandos necessários sem `redis`, `ioredis`, cache library ou rate-limit library.

## Decision

Redis terá somente duas responsabilidades, isoladas por prefixos:

- `rate-limit:v1`: fixed-window rate limiting;
- `transaction-cache:v1`: cache-aside de `Transaction` final.

O limiter usa Lua para executar `INCR`, `PEXPIRE` e `PTTL` atomicamente. O contador e TTL sobrevivem à troca de instância da API. A política em erro ou timeout Redis é fail-open, com aviso operacional seguro no composition root. `Retry-After` é calculado do TTL retornado pelo próprio script.

`GetTransaction` depende do port específico `TransactionCache`. Em hit válido, não consulta repository. Em miss ou erro, consulta PostgreSQL e tenta popular Redis. Falha no write é ignorada depois do read PostgreSQL bem-sucedido. O cache usa JSON estrito validado com Zod, recria `createdAt` e remove conteúdo inválido quando possível.

O TTL default é uma hora porque a `Transaction` aprovada é imutável no escopo atual. POST não faz write-through; o primeiro GET popula o cache. Não há cache de 404, listagem, paginação, operation `processing` ou idempotência.

Cada operação Redis tem deadline local default de 250 ms. O cliente usa offline queue desabilitada e uma tentativa curta de reconnect. O deadline libera a request, mas não cancela um comando que já tenha sido enviado.

## Consequences

Réplicas compartilham rate limit e cache. Redis pode ser esvaziado sem perder transações ou idempotência. Redis indisponível aumenta reads no PostgreSQL e desativa temporariamente o rate limiting, mas não impede um GET se PostgreSQL estiver saudável.

Fixed window permite burst na fronteira entre janelas. Fail-open reduz proteção contra abuso durante outage. Cache misses concorrentes podem causar reads PostgreSQL repetidos. Não há Redlock, single-flight, negative caching ou invalidation distribuída.

O cliente nativo documenta suporte a Redis 7.2+ e ainda não suporta Redis Cluster ou Sentinel. Esses limites devem ser considerados no desenho futuro de deployment. Métricas de hit, miss, erro e rejeição serão conectadas quando existir a infraestrutura de observabilidade.
