resource "aws_dynamodb_table" "pr_messages" {
  name         = "${var.name}-pr-messages"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "repo_pr"

  # Key namespaces by prefix:
  #   "org/frontend#42"  → PR state item (routes, message_ts, reviewers)
  #   "delivery#<guid>"  → webhook-delivery dedup marker (idempotency)
  #   "user#<login>"     → cached github→slack resolution

  attribute {
    name = "repo_pr"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = merge(local.tags, { Name = "${var.name}-pr-messages" })
}
