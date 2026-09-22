# AWS Terraform target

This directory defines the Phase 9 target architecture. It has not been
applied. The configuration intentionally creates no secret values and no ACM
certificate; those inputs must be bootstrapped separately before a real
deployment.

The default topology has two AZs, public ALB subnets, private ECS/RDS/Redis
subnets, and one NAT Gateway for outbound provider traffic. The single NAT is a
portfolio cost trade-off, not a high-availability claim. RDS and ElastiCache
are private and reachable only from the ECS task security group.

For a cheaper temporary lab, set `use_private_tasks = false`. Tasks then run in
public subnets with public IPs, but their security group still accepts inbound
traffic only from the ALB; RDS and Redis remain private. This avoids the NAT
Gateway charge while weakening the network posture compared with the preferred
private-task topology. Production should use private tasks with deliberate
egress.

The API and deterministic fake provider run as two containers in one ECS task.
The API calls `127.0.0.1:4003`; this sidecar is lab infrastructure only. A real
deployment would call the external payment provider instead.

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
