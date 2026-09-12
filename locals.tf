data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  tags = merge(var.tags, {
    Module = "terraform-aws-reviewbell"
  })

  # Lambda env vars cannot be null — coalesce to empty string
  default_github_org  = var.default_github_org != null ? var.default_github_org : ""
  github_api_base_url = var.github_api_base_url != null ? var.github_api_base_url : ""
}
