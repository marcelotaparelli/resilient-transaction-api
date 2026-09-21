# resilient-transaction-api

API de processamento de transações construída com Bun, TypeScript, PostgreSQL e Clean Architecture. O projeto demonstra dinheiro em minor units, integração externa resiliente e idempotência com garantia de concorrência baseada em constraints e operações atômicas do banco.

Este é um case de engenharia. Não é um sistema financeiro real e não implementa ledger, settlement, chargeback, antifraude ou PCI DSS.

## Arquitetura atual

```text
Client
   ↓
Bun HTTP handler
   ↓
Application use cases
   ↓
Ports
   ↓
Infrastructure
   ├── PostgreSQL repository
   ├── In-memory rate limiter
   └── HTTP payment provider
            ↓
       Fake provider
```

PostgreSQL é a source of truth para transações e idempotência. O adapter in-memory permanece apenas como test double. Domain e Application não conhecem Bun, HTTP, Zod ou SQL.

O uso do cliente PostgreSQL nativo está registrado em [ADR 0001](docs/adr/0001-use-bun-sql-for-postgresql.md). `Bun.SQL` atende pool, parâmetros, transações e migrations sem uma dependência adicional.

## Dinheiro e Transaction

`amount` é um inteiro em minor units: `1099 BRL` representa R$ 10,99. A API rejeita floats, zero, valores negativos e números fora do intervalo seguro do JavaScript.

`Transaction` representa somente o resultado de negócio aprovado:

- `id`: UUID interno;
- `amount`: minor units;
- `currency`: três letras normalizadas;
- `description`: 1 a 200 caracteres;
- `providerTransactionId`: identidade externa;
- `status`: `approved`;
- `createdAt`: instante de criação.

Estados operacionais não foram adicionados à `Transaction`.

## Idempotência concorrente

O estado operacional fica em `idempotency_operations`, separado de `transactions`, com dois estados mínimos:

- `processing`: a chave foi adquirida e ainda não existe resultado local final;
- `completed`: a transação foi persistida e vinculada à operação.

O fingerprint é SHA-256 da representação JSON canônica de `amount`, `currency` normalizada e `description` normalizada. IDs, timestamps e headers não participam do hash.

O claim começa com:

```sql
INSERT ...
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING idempotency_key
```

A primary key de `idempotency_key` é a garantia atômica. Não existe `SELECT → INSERT`, mutex em memória ou distributed lock.

Resultados possíveis:

- `new_claim`: esta execução pode chamar o provider;
- `completed_replay`: devolve a mesma `Transaction` persistida;
- `fingerprint_conflict`: mesma chave com payload lógico diferente;
- `processing`: outra execução está ativa.

`processing` retorna imediatamente HTTP `409`, código `IDEMPOTENCY_OPERATION_IN_PROGRESS` e `Retry-After: 1`. Não existe espera ou polling infinito no request.

O timeout de processamento é configurado por `IDEMPOTENCY_PROCESSING_TIMEOUT_MS`, default 30 segundos. Após essa janela, uma operação ainda `processing` pode ser reclamada atomicamente. O valor deve ser maior que a duração máxima normal da política do provider. O reclaim permite recuperar crash ou falha entre aprovação externa e persistência.

## Limites da garantia

API idempotency não equivale a exactly-once external side effects.

Se o provider processar e a resposta for perdida, timeout não prova que o pagamento falhou. Por isso erros ambíguos deixam a operação em `processing`. Um retry após a janela reutiliza a mesma `Idempotency-Key` no provider.

Se o provider aprovar e PostgreSQL falhar, a transação e a conclusão são protegidas por uma transação curta: ou ambas persistem, ou ambas sofrem rollback. A operação continua `processing` e pode ser reclamada. Na nova tentativa, o provider precisa honrar a mesma chave e retornar seu resultado anterior.

Durante um reclaim por timeout, a execução anterior pode ainda estar viva. Isso pode gerar mais de uma chamada externa com a mesma key. A constraint garante somente uma `Transaction` interna final; a deduplicação do side effect externo depende do contrato idempotente do provider. Não há claim de exactly-once.

Rejeição HTTP definitiva do provider libera a claim para um retry seguro. Timeout, falha de rede, `5xx` e resposta externa inválida são tratados como resultados potencialmente ambíguos e mantêm `processing`.

## Persistência e ordenação

Migrations ficam em `migrations/` e nunca são aplicadas automaticamente no startup. A conclusão executa em uma transação PostgreSQL curta:

```text
INSERT Transaction
→ UPDATE operation para completed
→ COMMIT
```

A chamada HTTP ao provider ocorre depois do commit da claim e antes da transação de conclusão. Nenhum lock ou transaction PostgreSQL fica aberto durante rede externa.

Listagens usam:

```sql
ORDER BY created_at DESC, id DESC
```

Há um índice correspondente. A paginação continua baseada em `page` e `limit`, com limite máximo de 100.

## HTTP

- `GET /health`
- `POST /transactions`
- `GET /transactions/:id`
- `GET /transactions?page=1&limit=20`

Erros preservam o envelope:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_CONFLICT",
    "message": "Idempotency key was already used for a different transaction"
  }
}
```

SQL, connection strings, erros brutos e stack traces não são enviados ao cliente.

`X-Client-Id` ainda identifica somente o bucket do rate limiter local. Ele não é autenticação nem identidade confiável.

## Provider atual

Cada tentativa tem timeout de 3 segundos com `AbortController`. Timeout, falha de rede e `5xx` recebem até três tentativas, com esperas de 500 ms e 1.000 ms. A mesma `Idempotency-Key` é propagada em todas as tentativas.

Jitter, HTTP `429`, circuit breaker e fault injection adicional pertencem à Fase 3 e não estão implementados ainda.

## Como rodar

Pré-requisitos:

- Bun;
- PostgreSQL acessível;
- banco criado para a aplicação.

```bash
bun install
export DATABASE_URL='postgres://user:password@localhost:5432/resilient_transactions'
bun run migrate
```

Inicie o fake provider:

```bash
bun run provider
```

Em outro terminal:

```bash
bun run dev
```

A API usa `http://localhost:4002`; o provider usa `http://localhost:4003`.

## Exemplo

```bash
curl -i -X POST http://localhost:4002/transactions \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: client-123' \
  -H 'Idempotency-Key: tx-123' \
  -d '{"amount":1099,"currency":"BRL","description":"Order 123"}'
```

## Testes

Testes unitários não precisam de banco:

```bash
bun test tests/application tests/http tests/infrastructure/in-memory-transaction-repository.test.ts
```

Os testes de integração exigem um banco PostgreSQL descartável. Eles removem e recriam as tabelas do schema `public`; nunca aponte `TEST_DATABASE_URL` para um banco compartilhado ou com dados importantes.

```bash
export TEST_DATABASE_URL='postgres://user:password@localhost:5432/resilient_transaction_test'
bun run test:integration
TEST_DATABASE_URL="$TEST_DATABASE_URL" bun test
bun run typecheck
```

A suíte de integração aplica migrations a partir de vazio, testa constraints, 20 claims concorrentes, uma única chamada ao provider, replay após nova instância do repository, conflitos de fingerprint, rollback, reclaim, ordenação e paginação.

## Limitações atuais

- a correção do side effect externo depende da idempotência oferecida pelo provider;
- o reclaim usa lease por tempo e pressupõe relógios razoavelmente sincronizados;
- rate limiting ainda é local ao processo;
- não há autenticação;
- não há Redis/cache;
- não há jitter ou circuit breaker;
- não há limite explícito de bytes do body;
- não há observabilidade avançada ou graceful shutdown;
- não há Docker ou infraestrutura AWS.
