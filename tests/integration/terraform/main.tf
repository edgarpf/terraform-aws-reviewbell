terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.64.0"
    }
  }
}

variable "endpoint" {
  type = string
}

variable "region" {
  type = string
}

provider "aws" {
  access_key                  = "test"
  secret_key                  = "test"
  region                      = var.region
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    cloudwatch = var.endpoint
    dynamodb   = var.endpoint
    iam        = var.endpoint
    lambda     = var.endpoint
    logs       = var.endpoint
    ssm        = var.endpoint
    sts        = var.endpoint
  }
}

module "reviewbell" {
  source = "../../.."

  name           = "reviewbell-integration"
  lambda_runtime = "nodejs20.x"

  github_orgs = {
    acme = {
      webhook_secret = "integration-secret"
      token          = "integration-token"
    }
  }

  slack_workspaces = {
    eng = {
      bot_token = "xoxb-integration"
    }
  }

  mappings = [{
    repo = "acme/widget"
    destinations = [{
      workspace = "eng"
      channels  = []
    }]
  }]

  tags = {
    Test = "floci"
  }
}

output "function_name" {
  value = module.reviewbell.function_name
}

output "table_name" {
  value = module.reviewbell.dynamodb_table_name
}
