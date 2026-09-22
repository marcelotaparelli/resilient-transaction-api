resource "aws_ecs_cluster" "this" {
  name = local.name_prefix
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  skip_destroy             = false

  container_definitions = jsonencode([
    {
      name                   = local.container_name
      image                  = "${aws_ecr_repository.api.repository_url}:${var.container_image_tag}"
      essential              = true
      user                   = "bun"
      readonlyRootFilesystem = true
      portMappings = [{
        containerPort = var.api_container_port
        hostPort      = var.api_container_port
        protocol      = "tcp"
      }]
      environment = [
        { name = "HTTP_HOST", value = "0.0.0.0" },
        { name = "PORT", value = tostring(var.api_container_port) },
        { name = "PROVIDER_URL", value = var.provider_url },
      ]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
        { name = "SERVICE_CREDENTIALS", valueFrom = aws_secretsmanager_secret.service_credentials.arn },
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"const c=new AbortController();const t=setTimeout(()=>c.abort(),1000);try{const r=await fetch('http://127.0.0.1:'+Bun.env.PORT+'/health/ready',{signal:c.signal});process.exit(r.ok?0:1)}catch{process.exit(1)}finally{clearTimeout(t)}\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      stopTimeout = 20
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name                              = local.name_prefix
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  enable_execute_command            = false

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = local.container_name
    container_port   = var.api_container_port
  }

}
