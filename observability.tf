resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn
  tags              = merge(local.tags, { Name = var.name })
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  count = length(var.alarm_sns_topic_arns) > 0 ? 1 : 0

  alarm_name          = "${var.name}-lambda-errors"
  namespace           = "ReviewBell"
  metric_name         = "ProcessingErrors"
  dimensions          = { FunctionName = aws_lambda_function.this.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_sns_topic_arns
  ok_actions          = var.alarm_sns_topic_arns
  tags                = merge(local.tags, { Name = "${var.name}-lambda-errors" })
}

resource "aws_cloudwatch_log_metric_filter" "processing_errors" {
  count = length(var.alarm_sns_topic_arns) > 0 ? 1 : 0

  name           = "${var.name}-processing-errors"
  pattern        = "\"event_failed\""
  log_group_name = aws_cloudwatch_log_group.this.name

  metric_transformation {
    name      = "ProcessingErrors"
    namespace = "ReviewBell"
    value     = "1"
    dimensions = {
      FunctionName = var.name
    }
  }
}
