# ADR 0007 — AWS target architecture with ECS/Fargate

## Status

Validated in a temporary AWS lab in `us-east-1`, then destroyed. This ADR does
not claim a production deployment or permanent availability.

## Decision

The target deployment is an internet-facing HTTPS Application Load Balancer
forwarding to an ECS/Fargate service. The temporary lab ran tasks in public
subnets with public IPs, constrained by an ALB-only inbound security group. The
preferred production topology remains private task subnets with deliberate
NAT/VPC endpoint egress. Both topologies use PostgreSQL on private RDS and Redis
on private ElastiCache. The API image is pulled from ECR, runtime secrets are
referenced from Secrets Manager, and stdout/stderr is sent to CloudWatch Logs.

RDS remains the source of truth for transactions and idempotency. ElastiCache
is only the cache and distributed rate limiter, so a Redis outage keeps the API
available in its existing degraded/fail-open mode. The provider is outside the
VPC and is therefore reached through outbound egress.

## Network and cost trade-off

The preferred topology uses two AZs, public ALB subnets, private application
subnets, and deliberate egress for outbound provider calls. The temporary lab
set `use_private_tasks=false`, so it avoided a NAT Gateway and placed Fargate
tasks in public subnets with public IPs. RDS and Redis had no public address and
their security groups accepted traffic only from the ECS task security group.
The lab had one desired task, so it did not validate multi-replica rate-limit
sharing.

## Lifecycle

The target group checks `/health/ready`, while `/health/live` remains a process
probe. ALB deregistration is 20 seconds and the ECS container stop timeout is
20 seconds, matching the application's 15-second graceful shutdown period.
The provider is excluded from readiness because its outage is handled by the
existing timeout, retry and local breaker behavior.

## Secrets and IAM

Terraform creates empty Secrets Manager containers only. In the lab, secret
values were inserted through the AWS integration process and were not committed
to the repository. Secret values must be
bootstrapped out of band and are never placed in Terraform files, image layers,
or ECS environment plaintext. The execution role reads ECR/logging/secrets;
the application task role has no AWS permissions because the application does
not call AWS APIs.

## Why Fargate

Fargate matches the case's goals: a long-running container, connection pools,
graceful shutdown, readiness, concurrency and private PostgreSQL/Redis network
paths. Lambda is not rejected generally; it is simply less aligned with these
specific operational behaviors.
