# resilient-transaction-api

API de processamento de transações construída com Bun, TypeScript e Clean Architecture. A versão atual é a base in-memory do case: valida contratos em runtime, integra com um provider HTTP e mantém o núcleo independente de detalhes de transporte e persistência.

## Arquitetura

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
   ├── In-memory repository
   ├── In-memory rate limiter
   └── HTTP payment provider
            ↓
       Fake provider
```

`domain` contém o modelo da transação. `application` contém casos de uso, erros e ports sem conhecer Bun, HTTP, Zod ou adapters. `infrastructure` implementa os ports. `http` valida e traduz requests, responses e erros. `main.ts` instancia e conecta as implementações.

O handler HTTP é criado separadamente do listener. Isso permite testar requests e responses diretamente, sem abrir sockets; `Bun.serve` permanece restrito a `startServer`.

## Dinheiro e modelo da transação

`amount` é um inteiro em minor units. Por exemplo, `1099 BRL` representa R$ 10,99. A API rejeita zero, valores negativos, frações e números acima do limite seguro de inteiros do JavaScript. Esta fase não usa `Decimal` ou bibliotecas de precisão porque não realiza cálculos monetários fracionários.

Uma transação aprovada contém:

- `id`: identidade interna gerada pela API;
- `amount`: valor inteiro em minor units;
- `currency`: código de três letras normalizado para maiúsculas;
- `description`: texto entre 1 e 200 caracteres;
- `status`: estado interno final `approved`;
- `providerTransactionId`: identidade retornada pelo provider;
- `createdAt`: instante de criação.

O provider retorna apenas seu próprio resultado (`providerTransactionId` e `decision`). Ele não define a estrutura da transação interna.

## Endpoints

- `GET /health`
- `POST /transactions`
- `GET /transactions/:id`
- `GET /transactions?page=1&limit=20`

As rotas de transações exigem `X-Client-Id`. Nesta fase esse header identifica o bucket do rate limiter, mas não é uma identidade confiável nem autenticação. Autenticação por credencial de serviço será adicionada na fase de segurança.

Erros usam um envelope estável:

```json
{
  "error": {
    "code": "TRANSACTION_NOT_FOUND",
    "message": "Transaction not found"
  }
}
```

O objeto `error` poderá receber `requestId` posteriormente sem mudar sua estrutura principal. Mensagens internas e stack traces não são enviados ao cliente.

## Idempotência

A API encaminha a mesma `Idempotency-Key` ao provider e consulta o repository antes de processar uma nova transação.

Sequential replay is supported in the in-memory adapter. Atomic idempotency under concurrency is intentionally deferred to the PostgreSQL implementation.

Esta versão não oferece `requestFingerprint`, conflito para payload diferente, reserva atômica ou garantia de processamento concorrente. A próxima fase implementará esses invariantes com PostgreSQL, `UNIQUE`, transações e testes de integração reais. API idempotency não será descrita como exactly-once para side effects externos.

## Provider e rate limiting atuais

Cada tentativa contra o provider possui timeout de 3 segundos com `AbortController`. Timeout, falha de rede e respostas `5xx` recebem até três tentativas, com esperas de 500 ms e 1.000 ms. Rejeições e respostas que não cumprem o schema não recebem retry.

O rate limiter fixed-window permite cinco requisições por `X-Client-Id` a cada 60 segundos. Tanto o repository quanto o rate limiter são locais ao processo e servem somente para desenvolvimento e testes nesta fase.

## Validação

- `amount`: inteiro positivo e seguro;
- `currency`: exatamente três letras;
- `description`: 1 a 200 caracteres;
- `Idempotency-Key`: 1 a 128 caracteres;
- `X-Client-Id`: 1 a 128 caracteres;
- `page`: inteiro positivo, máximo 1.000.000, default 1;
- `limit`: inteiro positivo, máximo 100, default 20;
- bodies e queries rejeitam campos inesperados.

Um limite explícito de bytes para o request body permanece para a fase de HTTP hardening.

## Como rodar

```bash
bun install
```

Inicie o fake provider:

```bash
bun run provider
```

Em outro terminal, inicie a API:

```bash
bun run dev
```

A API usa `http://localhost:4002` e o provider usa `http://localhost:4003`.

## Exemplos

Health check:

```bash
curl -i http://localhost:4002/health
```

Criar uma transação:

```bash
curl -i -X POST http://localhost:4002/transactions \
  -H 'Content-Type: application/json' \
  -H 'X-Client-Id: client-123' \
  -H 'Idempotency-Key: tx-123' \
  -d '{"amount":1099,"currency":"BRL","description":"Order 123"}'
```

Consultar pelo `id` interno retornado na criação:

```bash
curl -i http://localhost:4002/transactions/TRANSACTION_ID \
  -H 'X-Client-Id: client-123'
```

Listar transações:

```bash
curl -i 'http://localhost:4002/transactions?page=1&limit=20' \
  -H 'X-Client-Id: client-123'
```

## Testes e typecheck

```bash
bun test
bun run typecheck
```

Os testes cobrem casos de uso, replay sequencial, falha do provider, repository in-memory, ordenação, paginação, schemas, consulta por ID, envelope de erro e handler HTTP sem socket.

## Limitações atuais

- dados e rate limit são perdidos em reinícios;
- réplicas não compartilham estado;
- concorrência idempotente ainda não possui garantia atômica;
- mesma chave com payload diferente ainda não gera conflito;
- não há autenticação;
- não há cache, circuit breaker, observabilidade ou graceful shutdown;
- não há limite explícito de bytes do body;
- não há PostgreSQL, Redis, Docker ou infraestrutura AWS.

A próxima fase substitui a persistência real por PostgreSQL com migrations, constraints, fingerprint determinístico e idempotência concorrente. O repository in-memory continuará disponível para testes unitários.
