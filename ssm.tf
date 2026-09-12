resource "aws_ssm_parameter" "github_orgs" {
  name  = "/${var.name}/github_orgs"
  type  = "SecureString"
  value = jsonencode(var.github_orgs)
  tags  = merge(local.tags, { Name = "${var.name}-github-orgs" })
}

resource "aws_ssm_parameter" "slack_workspaces" {
  name  = "/${var.name}/slack_workspaces"
  type  = "SecureString"
  value = jsonencode(var.slack_workspaces)
  tags  = merge(local.tags, { Name = "${var.name}-slack-workspaces" })
}
