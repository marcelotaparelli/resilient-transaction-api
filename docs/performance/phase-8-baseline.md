# Fase 8 — baseline de performance

Esta medição foi executada em 22/09/2026 contra o stack local containerizado
(API, PostgreSQL, Redis e fake provider). O benchmark não representa produção,
AWS ou tráfego distribuído.

## Ambiente

- Linux 6.12.98, x86_64, 4 vCPUs, aproximadamente 3,8 GiB de RAM e sem swap.
- Docker 20.10.24; Docker Compose 1.29.2.
- API em `oven/bun:1.4.2-slim`, PostgreSQL 15.19 e Redis 7.2.16.
- Cliente e servidor executados na mesma máquina/daemon Docker.
- Limite de rate limiting elevado somente para os cenários de throughput:
  `RATE_LIMIT_MAX_REQUESTS=100000`, janela de 60 s.
- Credencial usada exclusivamente no ambiente local: `compose-smoke`.

## Método

O harness em `benchmarks/http-benchmark.ts` usa apenas `fetch` e APIs nativas
do Bun. Cada cenário teve 20 requests de aquecimento e três execuções de 300
requests, salvo os ensaios controlados explicitamente menores. As latências são
medidas no cliente com `performance.now()`; p50/p95/p99 são percentis dos
requests concluídos. Erros são respostas HTTP fora do sucesso esperado ou
falhas de transporte.

Comandos representativos:

```bash
BENCHMARK_API_KEY=... bun benchmarks/http-benchmark.ts \
  --scenario=cache-hit --run=1 --requests=300 --concurrency=25
```

Os resultados brutos estão em `artifacts/benchmarks/` em JSONL.

## Resultados principais

Médias das três execuções (mesmo-host, concorrência 25):

| Cenário | p50 | p95 | p99 | req/s | erros |
| --- | ---: | ---: | ---: | ---: | ---: |
| GET cache hit | 3,065 ms | 4,818 ms | 5,833 ms | 7.524,7 | 0 |
| GET cache miss | 7,301 ms | 10,210 ms | 11,706 ms | 3.289,3 | 0 |
| GET replay persistente | 6,712 ms | 9,696 ms | 11,513 ms | 3.502,0 | 0 |
| POST novo | 20,871 ms | 31,805 ms | 35,610 ms | 1.129,9 | 0 |

O cache hit foi aproximadamente 2,3x mais rápido em p50 e 2,3x maior em
throughput que o miss neste ambiente. A diferença inclui o custo de consultar o
PostgreSQL e popular o Redis; não é uma comparação isolada de uma única query.

O cenário de fallback com Redis parado foi executado com 100 requests e
concorrência 10: três runs produziram, respectivamente, p50/p95/p99 de
753,890/756,160/756,427 ms, 195,172/754,973/756,931 ms e
192,934/210,598/210,648 ms. Todos os requests retornaram 200. A variação mostra
o custo do timeout/failure handling do Redis e não deve ser resumida a uma única
latência representativa.

## Concorrência progressiva — cache hit

Médias de três runs com 300 requests:

| Concorrência | p50 | p95 | p99 | req/s |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0,383 ms | 0,498 ms | 0,614 ms | 2.508,8 |
| 10 | 1,590 ms | 2,697 ms | 3,439 ms | 6.217,9 |
| 50 | 7,918 ms | 16,712 ms | 17,655 ms | 5.918,6 |

Neste ambiente o throughput deixou de crescer de forma consistente entre
concorrência 10 e 50, enquanto a cauda aumentou. Isso é um sinal de saturação
do caminho local/contêiner, não uma atribuição causal definitiva a um único
componente.

## Ensaios controlados

- Provider com 100 ms de latência artificial, 100 POSTs, concorrência 10:
  p50 109,281 ms, p95 149,119 ms, p99 153,961 ms, 87,815 req/s, zero erros.
- Retry `503 → success`: uma operação retornou 201 em 626,263 ms; a métrica do
  processo registrou uma falha e um retry, preservando a mesma Idempotency-Key.
- Vinte POSTs concorrentes com a mesma key: 1 resposta 201, 4 replays 200 e
  15 respostas 409 de processamento concorrente; duração observada 42,388 ms.
- Rate limiting separado com limite 5/60 s: quatro requests foram permitidas
  no intervalo já iniciado e quatro foram rejeitadas com 429 e `Retry-After: 5`.
  O teste não foi misturado aos números de throughput.

## Observação de recursos

Snapshot após os ensaios (`docker stats --no-stream`), não uma medição de pico:

| Serviço | CPU | Memória |
| --- | ---: | ---: |
| API | 0,19% | 28,45 MiB |
| PostgreSQL | 4,57% | 75,88 MiB |
| Redis | 0,14% | 7,605 MiB |
| Fake provider | 0,11% | 5,172 MiB |

## Gargalos e decisão de otimização

O custo mais evidente foi o caminho Redis indisponível: os timeouts locais
dominam a cauda antes do fallback ao PostgreSQL. Também houve degradação de
cauda em concorrência 50. Nesta fase não foi aplicada otimização de código,
pool, SQL, TTL ou logging: os dados ainda não isolam uma mudança de alto sinal
sem risco de alterar semântica. A próxima investigação deve medir separadamente
timeouts do cliente Redis e uso do pool PostgreSQL antes de qualquer ajuste.

## Limitações e resultados publicáveis

Os números são uma baseline local, com fake provider, cliente e servidor na
mesma máquina, dataset controlado e configuração de rate limit elevada. Não são
generalizáveis para AWS, produção ou múltiplas réplicas.

Resultados defensáveis para o portfólio devem manter o contexto completo, por
exemplo: “neste host Linux x86_64 de 4 vCPUs, o GET cache-hit atingiu em média
7.524,7 req/s, p95 de 4,818 ms e zero erros, com concorrência 25 e stack Docker
local”.
