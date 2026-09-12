provider "aws" {
  region = "us-east-1"
}

module "reviewbell" {
  source = "../.."

  name = "reviewbell-example"

  github_orgs = {
    "example-org" = {
      webhook_secret = "replace-me"
      token          = "ghp_replace_me"
    }
  }

  slack_workspaces = {
    eng = {
      bot_token = "xoxb-replace-me"
    }
  }

  mappings = [
    {
      repo = "example-org/frontend"
      destinations = [
        { workspace = "eng", channels = ["#frontend-prs"] }
      ]
    },
  ]

  user_map = {
    # "github-login" = "U0SLACKID"
  }

  personal_dms     = true
  author_dms       = true
  mention_dms      = true
  ignore_bots      = true
  ci_notifications = true

  log_retention_days = 90

  tags = {
    Example = "basic"
  }
}

output "webhook_url" {
  value = module.reviewbell.webhook_url
}
