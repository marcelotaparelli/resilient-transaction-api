# AWS lab real — validação temporária

## Objetivo

Validar a arquitetura do `resilient-transaction-api` em um ambiente AWS
temporário, sem tratá-lo como produção. O lab comprovou a integração entre
Terraform, ECR, ECS/Fargate, ALB HTTPS, RDS PostgreSQL, ElastiCache Redis,
Secrets Manager, IAM e CloudWatch Logs.

O ambiente foi criado em `us-east-1`, validado e destruído depois dos testes.
Nenhum segredo, token, account ID completo, ARN privado, password ou endpoint
privado é publicado neste documento.

## Arquitetura efetivamente usada

```text
Internet
   ↓ HTTPS / ACM
Application Load Balancer
   ↓ security group do ALB
ECS/Fargate task (public subnet + public IP no lab)
   ├── API container :4002
   └── fake-provider sidecar :4003
          ↓ localhost dentro da task
RDS PostgreSQL privado
ElastiCache Redis privado
Secrets Manager
CloudWatch Logs
```

O fake provider sidecar foi usado somente para o laboratório. Ele manteve o
fluxo determinístico sem depender de um provedor externo. Uma implantação real
usaria o payment provider externo através de egress controlado.

## Lab econômico versus arquitetura preferida

O lab usou `use_private_tasks=false`: as tasks Fargate ficaram em public
subnets com public IP, mas o security group da task permitia inbound somente a
partir do security group do ALB. RDS e ElastiCache permaneceram privados.

Essa escolha removeu o NAT Gateway e reduziu custo temporário, preservando a
prática de VPC, subnets, ALB, security groups e serviços privados de dados. A
topologia preferida para produção continua sendo ECS em private subnets com
egress deliberado por NAT Gateway e/ou VPC endpoints.

O lab tinha `desired=1`. Portanto, o rate limiting foi validado no ambiente
AWS, mas não houve demonstração de compartilhamento entre múltiplas réplicas.

## Processo executado

1. Imagens da API e do fake provider foram construídas e publicadas no ECR.
2. O Terraform criou a VPC, subnets, rotas, security groups, ALB, ECS,
   RDS, ElastiCache, Secrets Manager, IAM e CloudWatch Logs.
3. Uma task Fargate one-off executou as migrations contra o RDS.
4. O ECS service iniciou a task com os dois containers.
5. O target group aguardou o health check `/health/ready` ficar saudável.
6. Foram executados smoke tests HTTPS autenticados.
7. As evidências foram coletadas em `artifacts/aws-lab/`.
8. O ECR foi esvaziado e `terraform destroy` removeu os recursos do lab.

## Problemas reais e correções

- O RDS recusou `backup_retention_period=7` no ambiente usado. A configuração
  foi ajustada para `backup_retention_period=1` e permanece assim em
  [`infra/terraform/rds.tf`](../../infra/terraform/rds.tf).
- O PostgreSQL RDS exigiu TLS. O `DATABASE_URL` usado pela task foi corrigido
  para incluir `sslmode=require`.
- O fake provider sidecar evitou dependência de serviço de pagamento externo e
  não exigiu um segundo load balancer ou service discovery.

## Validações executadas

- `/health/ready`: HTTP 200 com `{"status":"ready"}`.
- Target group do ALB: `healthy`.
- POST autenticado: HTTP 201.
- Replay com a mesma `Idempotency-Key`: HTTP 200, mesmo transaction ID,
  providerTransactionId e createdAt.
- Cache-aside: `cache_miss_total 1` seguido de `cache_hit_total 1`.
- Rate limiting: cinco respostas HTTP 200 e a sexta HTTP 429.
- CloudWatch: eventos de requests 200/201/429, `rate_limit.rejected`,
  `RATE_LIMIT_EXCEEDED` e request IDs.
- ECS: desired 1, running 1, pending 0, failed 0.
- Migrations: executadas com sucesso pela task one-off.

As evidências sanitizadas estão em:

- [`ecs-service.json`](../../artifacts/aws-lab/ecs-service.json)
- [`health-ready.json`](../../artifacts/aws-lab/health-ready.json)
- [`alb-target-health.json`](../../artifacts/aws-lab/alb-target-health.json)
- [`cache-metrics.txt`](../../artifacts/aws-lab/cache-metrics.txt)
- [`cloudwatch-validation.log`](../../artifacts/aws-lab/cloudwatch-validation.log)

Os artifacts não contêm secrets.

## Destroy e auditoria

Depois da validação:

- imagens foram removidas do ECR;
- `terraform destroy` removeu 35/35 recursos;
- `terraform state list` ficou vazio;
- ECS, RDS, ElastiCache, ALB, ECR, CloudWatch Logs e Budget ficaram vazios na
  auditoria final;
- os secrets ficaram agendados para exclusão;
- o certificado ACM permaneceu `ISSUED` intencionalmente;
- o CNAME público `resilient` foi removido.

O certificado público ACM permaneceu ISSUED intencionalmente para possível reutilização futura. O certificado ACM público padrão usado com serviços integrados da AWS não possui cobrança adicional; o ALB e os demais recursos do laboratório já foram removidos.

## Claims públicas suportadas

É factual afirmar:

> A aplicação foi provisionada e validada em um laboratório AWS temporário em
> `us-east-1` usando Terraform, ECS/Fargate, ECR, ALB HTTPS, RDS PostgreSQL,
> ElastiCache, Secrets Manager, IAM e CloudWatch Logs, e depois destruída.

Também é factual afirmar que idempotência persistente, migrations, cache-aside,
rate limiting, readiness e logs CloudWatch foram exercitados nesse lab.

Não é suportado afirmar que o sistema é produção, highly available, multi-
replica, exatamente-once externamente ou que o rate limiter foi validado entre
réplicas. Os números da Fase 8 continuam sendo somente benchmark local
containerizado e não são resultados AWS.
