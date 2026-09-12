mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_region" {
    defaults = {
      id   = "us-east-1"
      name = "us-east-1"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::123456789012:role/reviewbell-test-lambda"
      id   = "reviewbell-test-lambda"
      name = "reviewbell-test-lambda"
    }
  }
}

variables {
  name = "reviewbell-test"

  github_orgs = {
    acme = {
      webhook_secret = "test-secret"
      token          = "test-token"
    }
  }

  slack_workspaces = {
    eng = {
      bot_token = "xoxb-test"
    }
  }

  mappings = [{
    repo = "acme/widget"
    destinations = [{
      workspace = "eng"
      channels  = ["#reviews"]
    }]
  }]

  tags = {
    Environment = "test"
  }
}

run "defaults_and_core_resources" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs24.x"
    error_message = "The documented Lambda runtime default changed."
  }

  assert {
    condition     = aws_lambda_function.this.memory_size == 256 && aws_lambda_function.this.timeout == 30
    error_message = "Lambda sizing defaults changed."
  }

  assert {
    condition     = aws_lambda_function.this.reserved_concurrent_executions == null
    error_message = "Reserved concurrency must remain opt-in."
  }

  assert {
    condition     = aws_lambda_function_url.this.authorization_type == "NONE"
    error_message = "The webhook Function URL must remain public and rely on HMAC authentication."
  }

  assert {
    condition     = aws_dynamodb_table.pr_messages.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.pr_messages.hash_key == "repo_pr"
    error_message = "DynamoDB must remain migration-free and serverless."
  }

  assert {
    condition     = aws_dynamodb_table.pr_messages.ttl[0].enabled && aws_dynamodb_table.pr_messages.ttl[0].attribute_name == "expires_at"
    error_message = "DynamoDB TTL must be enabled on expires_at."
  }

  assert {
    condition     = aws_ssm_parameter.github_orgs.type == "SecureString" && aws_ssm_parameter.slack_workspaces.type == "SecureString"
    error_message = "Service credentials must stay in SecureString parameters."
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.retention_in_days == 90 && aws_cloudwatch_log_group.this.kms_key_id == null
    error_message = "Log defaults changed."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.errors) == 0
    error_message = "The error alarm must be optional."
  }

  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.processing_errors) == 0
    error_message = "Processing-error infrastructure must remain opt-in."
  }

  assert {
    condition     = aws_lambda_function.this.tags["Module"] == "terraform-aws-reviewbell" && aws_lambda_function.this.tags["Environment"] == "test"
    error_message = "Module and caller tags must be merged."
  }

  assert {
    condition     = output.function_name == "reviewbell-test" && output.dynamodb_table_name == "reviewbell-test-pr-messages"
    error_message = "Documented outputs changed."
  }
}

run "optional_kms_alarm_and_concurrency" {
  command = plan

  variables {
    log_kms_key_arn      = "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    alarm_sns_topic_arns = ["arn:aws:sns:us-east-1:123456789012:reviewbell"]
    reserved_concurrency = 3
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.kms_key_id != null
    error_message = "The optional log KMS key was not applied."
  }

  assert {
    condition     = aws_lambda_function.this.reserved_concurrent_executions == 3
    error_message = "Reserved concurrency was not applied."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.errors) == 1 && aws_cloudwatch_metric_alarm.errors[0].namespace == "ReviewBell" && aws_cloudwatch_metric_alarm.errors[0].metric_name == "ProcessingErrors"
    error_message = "The custom processing-error alarm was not created."
  }

  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.processing_errors) == 1 && aws_cloudwatch_log_metric_filter.processing_errors[0].pattern == "\"event_failed\""
    error_message = "Processing errors must be sourced from the event_failed application log."
  }
}

run "iam_is_scoped_to_module_resources" {
  command = apply

  assert {
    condition     = aws_iam_role_policy.this.role == aws_iam_role.this.id && aws_iam_role_policy.this.policy == data.aws_iam_policy_document.this.json
    error_message = "The scoped inline policy is not attached to the Lambda role."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.basic.policy_arn == "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    error_message = "The Lambda role lost its standard logging policy."
  }
}

run "rejects_unknown_workspace" {
  command = plan

  variables {
    mappings = [{
      repo = "acme/widget"
      destinations = [{
        workspace = "missing"
        channels  = []
      }]
    }]
  }

  expect_failures = [var.mappings]
}

run "rejects_invalid_runtime_limits" {
  command = plan

  variables {
    lambda_memory_size   = 64
    lambda_timeout       = 0
    reserved_concurrency = -2
    log_retention_days   = 2
  }

  expect_failures = [
    var.lambda_memory_size,
    var.lambda_timeout,
    var.reserved_concurrency,
    var.log_retention_days,
  ]
}

run "rejects_invalid_mapping_references" {
  command = plan

  variables {
    default_github_org = "missing"
    mappings = [{
      repo = "not-a-repository"
      destinations = [{
        workspace = "eng"
        channels  = []
      }]
    }]
  }

  expect_failures = [
    var.default_github_org,
    var.mappings,
  ]
}
