resource "aws_lambda_function" "this" {
  function_name    = var.name
  role             = aws_iam_role.this.arn
  runtime          = var.lambda_runtime
  handler          = "index.handler"
  filename         = "${path.module}/lambda/handler.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda/handler.zip")
  timeout          = var.lambda_timeout
  memory_size      = var.lambda_memory_size

  # -1 means unreserved (omit the attribute)
  reserved_concurrent_executions = var.reserved_concurrency >= 0 ? var.reserved_concurrency : null

  depends_on = [aws_cloudwatch_log_group.this]

  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.this.name
  }

  environment {
    variables = {
      PR_TABLE               = aws_dynamodb_table.pr_messages.name
      GITHUB_ORGS_PARAM      = aws_ssm_parameter.github_orgs.name
      SLACK_WORKSPACES_PARAM = aws_ssm_parameter.slack_workspaces.name
      DEFAULT_GITHUB_ORG     = local.default_github_org
      GITHUB_API_BASE_URL    = local.github_api_base_url
      MAPPINGS               = jsonencode(var.mappings)
      DEFAULT_MAPPING        = jsonencode(var.default_mapping)
      USER_MAP               = jsonencode(var.user_map)
      MUTED_USERS            = jsonencode(var.muted_users)
      PERSONAL_DMS           = tostring(var.personal_dms)
      AUTHOR_DMS             = tostring(var.author_dms)
      MENTION_DMS            = tostring(var.mention_dms)
      IGNORE_BOTS            = tostring(var.ignore_bots)
      CI_NOTIFICATIONS       = tostring(var.ci_notifications)
      EMOJIS                 = jsonencode(var.emojis)
    }
  }

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_lambda_function_url" "this" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE" # GitHub webhook IPs not fixed; HMAC verified in app code
}
