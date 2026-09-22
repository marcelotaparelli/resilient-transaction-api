# AWS Terraform target

This directory defines the Phase 9 target architecture. It has not been
applied. The configuration intentionally creates no secret values and no ACM
certificate; those inputs must be bootstrapped separately before a real
deployment.

The default topology has two AZs, public ALB subnets, private ECS/RDS/Redis
subnets, and one NAT Gateway for outbound provider traffic. The single NAT is a
portfolio cost trade-off, not a high-availability claim. RDS and ElastiCache
are private and reachable only from the ECS task security group.

Before a future apply, an operator must:

1. install a compatible Terraform and AWS provider;
2. select an AWS account and region deliberately;
3. bootstrap the four Secrets Manager values referenced by the task;
4. provide a real provider URL and an existing ACM certificate ARN;
5. decide whether the Redis transit-encryption/auth-token configuration is
   appropriate for the account;
6. provide `budget_email` so the warning budget is created in the same first
   apply; the budget is an alert, not a hard spending cap;
7. configure a remote state backend with locking, if collaboration requires it;
8. build and push an immutable ECR image tag through the later CI/CD phase;
9. run `terraform init`, `terraform fmt-check`, `terraform validate` and a
   reviewed `terraform plan`.

Terraform state and secret values must never be committed. The current stack is
deliberately a single parameterized environment rather than a generic module
library.
