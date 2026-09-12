output "webhook_url" {
  description = "Public HTTPS endpoint for the GitHub webhook (Lambda Function URL)."
  value       = aws_lambda_function_url.this.function_url
}

output "function_name" {
  description = "Name of the ReviewBell Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the ReviewBell Lambda function."
  value       = aws_lambda_function.this.arn
}

output "dynamodb_table_name" {
  description = "Name of the DynamoDB table storing PR message state, delivery dedup markers, and user resolution cache."
  value       = aws_dynamodb_table.pr_messages.name
}

output "dynamodb_table_arn" {
  description = "ARN of the DynamoDB pr_messages table."
  value       = aws_dynamodb_table.pr_messages.arn
}

output "log_group_name" {
  description = "CloudWatch log group name for the Lambda function."
  value       = aws_cloudwatch_log_group.this.name
}

output "ssm_github_orgs_parameter" {
  description = "SSM SecureString parameter name holding github_orgs secrets."
  value       = aws_ssm_parameter.github_orgs.name
}

output "ssm_slack_workspaces_parameter" {
  description = "SSM SecureString parameter name holding slack_workspaces secrets."
  value       = aws_ssm_parameter.slack_workspaces.name
}
