output "vpc_id" {
  value = aws_vpc.this.id
}

output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "secret_arns" {
  value = {
    database_url        = aws_secretsmanager_secret.database_url.arn
    redis_url           = aws_secretsmanager_secret.redis_url.arn
    service_credentials = aws_secretsmanager_secret.service_credentials.arn
  }
}
