variable "aws_region" {
  description = "AWS region for the portfolio environment."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "resilient-transaction-api"
}

variable "environment" {
  type    = string
  default = "portfolio"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "Exactly two AZs are used by the portfolio topology."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Provide exactly two availability zones."
  }
}

variable "container_image_tag" {
  description = "Immutable image tag, preferably the source commit SHA."
  type        = string
  default     = "latest"
}

variable "provider_url" {
  description = "External payment provider URL. Supply a real HTTPS endpoint before apply."
  type        = string
  default     = "https://provider.example.invalid/transactions"
}

variable "api_container_port" {
  type    = number
  default = 4002
}

variable "task_cpu" {
  description = "Fargate CPU units; this is a conservative starting point, not a benchmark claim."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 1024
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN for HTTPS. No certificate is created by this stack."
  type        = string
  default     = null
  nullable    = true
}

variable "redis_auth_token" {
  description = "Sensitive ElastiCache auth token supplied out of band when transit encryption is enabled."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "redis_transit_encryption_enabled" {
  description = "Keep true for a real deployment; private networking remains the local baseline."
  type        = bool
  default     = true
}

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "rds_skip_final_snapshot" {
  description = "Convenient for a disposable portfolio environment; use false for retained environments."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "budget_email" {
  description = "Email for the lab budget alert. Required before the first apply."
  type        = string
  default     = null
  nullable    = true
}

variable "budget_limit_usd" {
  description = "Monthly warning budget for the temporary lab, not a hard spending cap."
  type        = number
  default     = 50
}
