# terraform-aws-reviewbell

Terraform module that deploys **ReviewBell** — a self-hosted GitHub → Slack pull request notifier on AWS Lambda + DynamoDB.

ReviewBell keeps a single in-place **channel status board** per PR and sends **directed DMs** only when GitHub emits an explicit action (review request, re-request, changes requested, or `@mention`). No notification spam.

## Features

- Multi-org GitHub + multi-workspace Slack routing
- In-place channel message updates (Block Kit status board)
- Reviewer / author / mention DMs with a deterministic low-noise model
- Draft PRs: ambient notifications wait for "ready"; deliberate DMs still fire
- Webhook security: HMAC-SHA256 + org allowlist
- Secrets in SSM Parameter Store `SecureString` (not Lambda env vars)
- Idempotent processing (atomic delivery leases + per-effect completion + deterministic Slack IDs)
- CloudWatch Logs (90-day retention by default, optional CMK) + optional processing-error alarm
- Self-contained: `lambda/handler.zip` is bundled — one `terraform apply` deploys everything

## Usage

```hcl
module "reviewbell" {
  source  = "edgarpf/reviewbell/aws"
  version = "~> 1.0"

  name = "reviewbell"

  github_orgs = {
    "acme-corp" = {
      webhook_secret = var.github_webhook_secret
      token          = var.github_token
    }
  }

  slack_workspaces = {
    eng = {
      bot_token = var.slack_bot_token
    }
  }

  mappings = [
    {
      repo         = "acme-corp/frontend"
      destinations = [{ workspace = "eng", channels = ["#frontend-prs"] }]
    },
    {
      repo         = "acme-corp/*"
      destinations = [{ workspace = "eng", channels = ["#engineering"] }]
    },
  ]

  user_map = {
    "jdoe" = "U0ABC123"
  }

  tags = {
    Environment = "prod"
  }
}

output "webhook_url" {
  value = module.reviewbell.webhook_url
}
```

After apply, point a GitHub org (or repo) webhook at `module.reviewbell.webhook_url` and invite the Slack bot to every target channel (`/invite @ReviewBell`).

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.15.0 |
| aws | ~> 6.54 |

## Providers

| Name | Version |
|------|---------|
| aws | ~> 6.54 |

## Resources

| Name | Type |
|------|------|
| [aws_lambda_function.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function) | resource |
| [aws_lambda_function_url.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function_url) | resource |
| [aws_dynamodb_table.pr_messages](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table) | resource |
| [aws_ssm_parameter.github_orgs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ssm_parameter) | resource |
| [aws_ssm_parameter.slack_workspaces](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/ssm_parameter) | resource |
| [aws_iam_role.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) | resource |
| [aws_cloudwatch_log_group.this](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_cloudwatch_log_metric_filter.processing_errors](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter) | resource |
| [aws_cloudwatch_metric_alarm.errors](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm) | resource |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| name | Name prefix for all resources | `string` | n/a | yes |
| github_orgs | Map of GitHub org login → `{ webhook_secret, token }` (sensitive, allowlist) | `map(object)` | n/a | yes |
| slack_workspaces | Map of workspace label → `{ bot_token, emojis? }` (sensitive) | `map(object)` | n/a | yes |
| mappings | Routing rules (exact > `org/*` > `*` precedence) | `list(object)` | n/a | yes |
| default_mapping | Fallback routing when no mapping matches | `object` | `null` | no |
| default_github_org | Default github_orgs key when a mapping omits it | `string` | `null` | no |
| github_api_base_url | GitHub API base URL (set for GHES) | `string` | `null` | no |
| user_map | GitHub username → Slack user ID overrides | `map(string)` | `{}` | no |
| muted_users | GitHub usernames that never receive DMs | `list(string)` | `[]` | no |
| personal_dms | DM reviewers on review request | `bool` | `true` | no |
| author_dms | In-place author DM on comments / changes requested | `bool` | `true` | no |
| mention_dms | DM users explicitly `@mentioned` | `bool` | `true` | no |
| ignore_bots | Drop events from GitHub Apps/bots | `bool` | `true` | no |
| ci_notifications | Reflect CI status on the channel badge | `bool` | `true` | no |
| emojis | Default emoji codes per PR state | `object` | see variables.tf | no |
| lambda_runtime | Lambda runtime | `string` | `"nodejs24.x"` | no |
| lambda_memory_size | Memory (MB) | `number` | `256` | no |
| lambda_timeout | Timeout (seconds) | `number` | `30` | no |
| reserved_concurrency | Reserved concurrency (`-1` = unreserved) | `number` | `-1` | no |
| log_retention_days | CloudWatch log retention | `number` | `90` | no |
| log_kms_key_arn | Optional CMK for log group encryption | `string` | `null` | no |
| alarm_sns_topic_arns | SNS topics for the log-derived processing-error alarm | `list(string)` | `[]` | no |
| tags | Extra resource tags | `map(any)` | `{}` | no |

## Outputs

| Name | Description |
|------|-------------|
| webhook_url | Public HTTPS endpoint for the GitHub webhook |
| function_name | Lambda function name |
| function_arn | Lambda function ARN |
| dynamodb_table_name | DynamoDB table name |
| dynamodb_table_arn | DynamoDB table ARN |
| log_group_name | CloudWatch log group name |
| ssm_github_orgs_parameter | SSM parameter name for github_orgs |
| ssm_slack_workspaces_parameter | SSM parameter name for slack_workspaces |

---

## Behavior in practice / use cases

ReviewBell exposes **two surfaces**:

1. **Channel board** — one Slack message per PR, updated in place. Never re-pings. Never `@mentions` anyone (names are plain text), unless `personal_dms = false`.
2. **DMs** — directed pings to reviewers, authors, or `@mentioned` users. Keyed off GitHub's explicit actions, not free-form comment intent.

### Scenario table

| ID | You do this on GitHub | Channel board | Who gets a DM |
|---|---|---|---|
| RB-001 | Open a normal PR | New message posted (badge OPEN) | Each already-requested reviewer is pinged |
| RB-002 | Open a **draft** PR | Nothing yet (waits for "ready") | Nobody ambient; only deliberate pings pierce |
| RB-003 | Mark draft "Ready for review" | Message posted (first time) | Assigned reviewers pinged |
| RB-004 | Request a reviewer (or "Re-request review") | Reviewer row added / reset to pending | That reviewer pinged (re-request re-pings) |
| RB-005 | Reviewer approves | Row → approved; badge flips when all observed reviewers approve | No DM |
| RB-006 | Reviewer requests changes | Row → changes requested | Author pinged (fresh ping) |
| RB-007 | Comment on the PR (no `@`) | No board change | Author's single DM updated in place (pings once, then silent); draft → suppressed |
| RB-008 | Comment with `@someone` | No board change | Mentioned user pinged with a link to that comment (works on drafts) |
| RB-009 | Author replies to a comment | No board change | Nobody (unless the reply `@mentions` someone) |
| RB-010 | CI passes / fails (`ci_notifications`) | Badge shows pass/fail | No DM |
| RB-011 | Merge the PR | Badge → MERGED + reaction | No DM |
| RB-012 | Close without merge | Badge → CLOSED | No DM |

### Worked timeline

```
B requests changes on A's PR       →  A pinged: "B requested changes on your PR"
A replies in a comment             →  nobody pinged (no re-request, no @mention)
A clicks Re-request review from B  →  B pinged: "A re-requested your review"
C comments "nice work"             →  A's DM silently updated; C pings no one
C comments "cc @dana can you peek" →  dana pinged (mention DM); A's DM silently updated
```

### Draft PRs

Comments, reviews, and review requests **do** fire on drafts, but:

- The **channel board** and **ambient author DMs** wait until the PR is marked ready.
- **Deliberate directed DMs** still go out: review request / re-request, `@mention`, and `changes_requested`.

### Tuning examples

Quietest setup (board only):

```hcl
personal_dms = false
author_dms   = false
mention_dms  = false
```

Reviewer pings only:

```hcl
personal_dms = true
author_dms   = false
mention_dms  = false
```

Mute a noisy account and disable CI badges:

```hcl
muted_users      = ["renovate-bot"]
ci_notifications = false
```

Per-repo overrides win over these globals (see `mappings`).

### Guarantees

- You are **never DM'd about your own action** (self-skip).
- Users in `muted_users` receive nothing in any role (author, reviewer, or mention).

---

## Setup

### Slack app

1. Create a Slack app with a bot user.
2. Add bot token scopes: `chat:write`, `im:write`, `reactions:write`, `users:read.email`, `channels:read`, `groups:read`.
3. Install the app to the workspace and copy the Bot User OAuth Token (`xoxb-...`).
4. **Invite the bot to every target channel** (`/invite @ReviewBell`). Without this, `chat.postMessage` returns `not_in_channel`.

### GitHub webhook

1. Org settings → Webhooks → Add webhook.
2. Payload URL = module output `webhook_url`.
3. Content type = `application/json`.
4. Secret = the same value you pass as `github_orgs[<org>].webhook_secret`.
5. Subscribe to events:
   - `Pull requests`
   - `Pull request reviews`
   - `Pull request review comments`
   - `Issue comments`
   - `Check suites` (only if `ci_notifications = true`)
6. GitHub token scopes: `read:user` + `repo` (or fine-grained equivalents that can read user emails when public and repo metadata).

### User resolution (important)

GitHub email is **private by default**. Automatic Slack resolution (`users.lookupByEmail`) only works when a member has a public work email that matches Slack. In most orgs, maintain `user_map` (GitHub username → Slack user ID) as the primary mechanism.

### GitHub Enterprise Server

```hcl
github_api_base_url = "https://github.example.com/api/v3"
```

---

## Architecture

```
GitHub webhook  →  Lambda Function URL  →  Lambda (HMAC bound to payload org)
                                              ├─ SSM SecureString (secrets, cold-start cache)
                                              ├─ DynamoDB (versioned PR state, leases, effects, user cache)
                                              ├─ Slack API (chat.postMessage / update / reactions)
                                              └─ CloudWatch Logs (+ optional event_failed metric → SNS)
```

Secrets stay in SSM; non-sensitive routing/behaviour config is passed as Lambda environment variables. Use an encrypted Terraform state backend — plaintext secret values are still written to tfstate by Terraform.

---

## Tests and contribution workflow

The README scenario table is an executable contract. `tests/contract/readme-contract.test.ts` owns the registered `RB-###` catalog and fails if the IDs in this document are added, removed, reordered, or duplicated without a matching test-suite change. The broader contract suite covers routing precedence and overrides, draft gates, self/mute guarantees, bot filtering, channel mentions, CI aggregation, retry safety, concurrent delivery claims, and partial fan-out recovery.

```bash
npm ci
npm test                  # fast unit + README contract suites
npm run test:coverage     # 90% statements/lines/functions, 85% branches
npm run build             # refresh lambda/handler.zip
terraform test -test-directory=tests/terraform
```

The AWS integration suite uses the official [Floci Node Testcontainers package](https://floci.io/floci/testcontainers/) with the pinned `floci/floci:2.0.1` image. It never uses real AWS, GitHub, or Slack accounts. Docker and Terraform 1.15.8 are required:

```bash
REVIEWBELL_INTEGRATION=1 npm run test:integration
```

GitHub Actions runs three fork-safe, secret-free jobs on pull requests and `main`: `quality`, `terraform`, and `integration`. Configure those three job names as required status checks in the repository's branch protection settings.

## Publishing to the Terraform Registry

1. Make the GitHub repo public: `edgarpf/terraform-aws-reviewbell`
2. Sign in at [registry.terraform.io](https://registry.terraform.io) → Publish → Module → link the repo
3. Tag a release: `git tag v1.0.0 && git push origin v1.0.0`
4. The Registry indexes the tag automatically within a few minutes

Consumers then use:

```hcl
module "reviewbell" {
  source  = "edgarpf/reviewbell/aws"
  version = "~> 1.0"
  # ...
}
```

## Developing the Lambda

```bash
npm install
npm run typecheck
npm run build   # writes lambda/handler.zip
```

CI rebuilds `handler.zip` on changes under `src/`. Commit the zip so consumers get a working module without a separate build step.

## License

MIT
