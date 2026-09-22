resource "aws_secretsmanager_secret" "database_url" {
  name        = local.database_secret_name
  description = "Bootstrap outside Terraform with the application DATABASE_URL"
}

resource "aws_secretsmanager_secret" "redis_url" {
  name        = local.redis_secret_name
  description = "Bootstrap outside Terraform with the application REDIS_URL"
}

resource "aws_secretsmanager_secret" "service_credentials" {
  name        = local.service_credentials_name
  description = "Bootstrap outside Terraform with SERVICE_CREDENTIALS JSON"
}
