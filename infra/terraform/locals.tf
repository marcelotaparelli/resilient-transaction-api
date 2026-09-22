locals {
  name_prefix = "${var.project_name}-${var.environment}"

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  public_subnet_cidrs  = ["10.42.0.0/20", "10.42.16.0/20"]
  private_subnet_cidrs = ["10.42.32.0/20", "10.42.48.0/20"]

  database_secret_name      = "${local.name_prefix}/database-url"
  redis_secret_name         = "${local.name_prefix}/redis-url"
  service_credentials_name  = "${local.name_prefix}/service-credentials"
  provider_credentials_name = "${local.name_prefix}/provider-credentials"
  container_name            = "api"
}
