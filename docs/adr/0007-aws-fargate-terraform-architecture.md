# ADR 0007 — AWS target architecture with ECS/Fargate

## Status

Proposed. Terraform is defined and statically reviewed; no AWS resource was
created and `terraform apply` was intentionally not executed.

## Decision

The target deployment is an internet-facing Application Load Balancer forwarding
to an ECS/Fargate service. Tasks run in private subnets and use PostgreSQL on
private RDS and Redis on private ElastiCache. The API image is pulled from ECR,
runtime secrets are referenced from Secrets Manager, and stdout/stderr is sent
to CloudWatch Logs.

RDS remains the source of truth for transactions and idempotency. ElastiCache
is only the cache and distributed rate limiter, so a Redis outage keeps the API
available in its existing degraded/fail-open mode. The provider is outside the
VPC and is therefore reached through outbound egress.

## Network and cost trade-off

The portfolio topology uses two AZs, public ALB subnets, private application
subnets, and one NAT Gateway for outbound provider calls. One NAT limits fixed
cost for a small environment but is not an availability claim; a production
deployment would normally evaluate one NAT per AZ or a deliberate egress
architecture. RDS and Redis have no public address and their security groups
accept traffic only from the ECS task security group.

## Lifecycle

The target group checks `/health/ready`, while `/health/live` remains a process
probe. ALB deregistration is 20 seconds and the ECS container stop timeout is
20 seconds, matching the application's 15-second graceful shutdown period.
The provider is excluded from readiness because its outage is handled by the
existing timeout, retry and local breaker behavior.

## Secrets and IAM

Terraform creates empty Secrets Manager containers only. Secret values must be
bootstrapped out of band and are never placed in Terraform files, image layers,
or ECS environment plaintext. The execution role reads ECR/logging/secrets;
the application task role has no AWS permissions because the application does
not call AWS APIs.

## Why Fargate

Fargate matches the case's goals: a long-running container, connection pools,
graceful shutdown, readiness, concurrency and private PostgreSQL/Redis network
paths. Lambda is not rejected generally; it is simply less aligned with these
specific operational behaviors.
