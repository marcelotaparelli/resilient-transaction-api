# ADR 0002: bounded provider resilience policy

## Status

Accepted.

## Context

O provider executa um side effect externo. Timeout, interrupção de rede, `5xx` e resposta inválida podem ocorrer depois de o provider ter aprovado a operação. Retry indiscriminado pode duplicar o efeito, enquanto ausência total de retry torna falhas transitórias desnecessariamente visíveis.

O PostgreSQL controla a idempotência da API, mas não consegue garantir exactly-once no sistema externo. O provider recebe a mesma `Idempotency-Key` em toda tentativa e precisa honrar esse contrato.

## Decision

O adapter HTTP executa uma tentativa com timeout. Um decorator aplica no máximo três tentativas, exponential backoff bounded e jitter injetável. Timeout, rede, `429`, `500`, `502`, `503` e `504` recebem retry. `4xx` permanentes são rejeições definitivas. Resposta inválida permanece ambígua e não recebe retry imediato.

O `500` recebe retry porque pode ser transitório. Como o request pode ter sido processado, ele continua ambíguo e só é seguro com a mesma key externa. `429` recebe retry, mas não alimenta o circuit breaker, pois pode representar quota específica da credencial em vez de falha global de saúde.

O breaker é pequeno, in-process e local a cada réplica. Ele observa o resultado final da operação bounded, não cada tentativa recuperada. O threshold default é três, o intervalo aberto é 10 segundos e somente uma probe entra em `half_open`.

A admissão no breaker ocorre antes da primeira tentativa. Se recusada, nenhuma chamada externa começou e uma claim PostgreSQL recém-adquirida pode ser liberada. Depois que uma operação foi admitida, sua política bounded termina sem uma nova checagem de admissão, evitando classificar uma tentativa já enviada como “não iniciada”.

O startup calcula 10.800 ms como pior janela de tentativas e delays, adiciona 2.000 ms de overhead e exige que o stale timeout exceda 12.800 ms por uma margem mínima configurada. Com o stale timeout default de 30.000 ms, a margem é 17.200 ms.

## Consequences

Falhas ambíguas esgotadas mantêm `idempotency_operations.status = processing`. Recovery por reclaim reutiliza a mesma key. Rejeições definitivas liberam a operação. Breaker aberto antes da chamada também libera a operação.

O breaker não coordena réplicas. Uma instância pode aceitar chamadas enquanto outra está aberta. O estado se perde no restart. Reclaim ainda pode sobrepor uma execução antiga em caso de pausa longa, clock skew ou stall além da margem. A deduplicação do side effect continua dependente da retenção e semântica de idempotência do provider.
