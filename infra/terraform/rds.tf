resource "aws_db_subnet_group" "postgres" {
  name       = "${local.name_prefix}-postgres"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "postgres" {
  identifier                  = local.name_prefix
  engine                      = "postgres"
  engine_version              = "15.19"
  instance_class              = var.rds_instance_class
  allocated_storage           = 20
  max_allocated_storage       = 50
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "resilient_transactions"
  username                    = "resilient_app"
  manage_master_user_password = true
  port                        = 5432
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 7
  deletion_protection         = false
  skip_final_snapshot         = var.rds_skip_final_snapshot
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [aws_security_group.rds.id]
  apply_immediately           = true
  copy_tags_to_snapshot       = true
}
