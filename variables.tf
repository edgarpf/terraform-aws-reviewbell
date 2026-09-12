# ── General ──────────────────────────────────────────────────────────────────────

variable "name" {
  description = "Name prefix applied to all resource names and tags."
  type        = string

  validation {
    condition     = length(trimspace(var.name)) > 0 && can(regex("^[A-Za-z0-9-_]+$", var.name))
    error_message = "name must be non-empty and contain only letters, numbers, hyphens, and underscores."
  }
}

# ── GitHub orgs ───────────────────────────────────────────────────────────────────

variable "github_orgs" {
  description = "Map of GitHub organisation names to their credentials. Keys must be the exact GitHub organisation login (e.g. 'acme-corp') — they are used as an allowlist: any webhook payload whose repository.owner.login is not a key here is rejected with 403, even if the HMAC signature is valid. The webhook_secret verifies payload authenticity; the token is used for GitHub API calls. Token requires read:user and repo scopes."
  type = map(object({
    webhook_secret = string
    token          = string
  }))
  sensitive = true

  validation {
    condition     = length(var.github_orgs) > 0
    error_message = "github_orgs must contain at least one organization."
  }
}

variable "default_github_org" {
  description = "Key from github_orgs (i.e. a GitHub org name) used when a mapping rule does not specify a github_org. Required when github_orgs has more than one entry and any mapping rule omits github_org."
  type        = string
  default     = null

  validation {
    condition     = var.default_github_org == null || contains(keys(var.github_orgs), var.default_github_org)
    error_message = "default_github_org must be a key in github_orgs."
  }
}

variable "github_api_base_url" {
  description = "Base URL for GitHub REST API calls. Leave null for github.com (https://api.github.com). Set to your GitHub Enterprise Server API endpoint (e.g. https://github.example.com/api/v3) when running against GHES."
  type        = string
  default     = null
}

# ── Slack workspaces ──────────────────────────────────────────────────────────────

variable "slack_workspaces" {
  description = "Map of workspace labels to Slack credentials and optional workspace-level emoji overrides. Each key is an arbitrary identifier referenced in mappings and default_mapping. Bot tokens require chat:write, im:write, reactions:write, users:read.email (for GitHub-email -> Slack-user resolution), and channels:read/groups:read (to resolve #channel names to IDs) scopes. The bot must also be invited to every target channel or chat.postMessage will fail. Workspace emojis override global var.emojis defaults — use this for custom workspace-specific emoji names that only exist in that workspace."
  type = map(object({
    bot_token = string
    emojis = optional(object({
      opened            = optional(string)
      approved          = optional(string)
      changes_requested = optional(string)
      merged            = optional(string)
      closed            = optional(string)
      ci_pass           = optional(string)
      ci_fail           = optional(string)
      merged_reaction   = optional(string)
    }))
  }))
  sensitive = true

  validation {
    condition     = length(var.slack_workspaces) > 0
    error_message = "slack_workspaces must contain at least one workspace."
  }
}

# ── Routing ───────────────────────────────────────────────────────────────────────

variable "mappings" {
  description = "Routing rules keyed by repo. Each entry fans out to one or more Slack workspaces, each delivering to one or more channels. Per-repo behaviour overrides fall back to global defaults when omitted. Match precedence (most specific wins): exact 'org/repo' > org wildcard 'org/*' > global catch-all '*' > default_mapping. Exactly one rule is applied per repo. Repo/org names are matched case-insensitively (GitHub logins are case-insensitive)."
  type = list(object({
    repo = string # "org/frontend" exact, "org/*" org-wide, or "*" catch-all

    destinations = list(object({
      workspace = string                     # key in slack_workspaces — required for DMs and channel posts
      channels  = optional(list(string), []) # channel IDs or #names; omit or [] for DM-only in this workspace
    }))

    github_org       = optional(string)
    muted_users      = optional(list(string), [])
    personal_dms     = optional(bool)
    author_dms       = optional(bool)
    mention_dms      = optional(bool)
    ignore_bots      = optional(bool)
    ci_notifications = optional(bool)
    emojis = optional(object({
      opened            = optional(string)
      approved          = optional(string)
      changes_requested = optional(string)
      merged            = optional(string)
      closed            = optional(string)
      ci_pass           = optional(string)
      ci_fail           = optional(string)
      merged_reaction   = optional(string)
    }))
  }))

  validation {
    condition = alltrue([
      for mapping in var.mappings :
      mapping.repo == "*" || can(regex("^[^/]+/(?:[^/]+|\\*)$", mapping.repo))
    ])
    error_message = "Each mapping repo must be '*', 'org/*', or an exact 'org/repo' name."
  }

  validation {
    condition = alltrue(flatten([
      for mapping in var.mappings : [
        for destination in mapping.destinations : contains(keys(var.slack_workspaces), destination.workspace)
      ]
    ]))
    error_message = "Every mapping destination workspace must be a key in slack_workspaces."
  }

  validation {
    condition = alltrue([
      for mapping in var.mappings :
      mapping.github_org == null || contains(keys(var.github_orgs), mapping.github_org)
    ])
    error_message = "Every mapping github_org must be a key in github_orgs."
  }
}

variable "default_mapping" {
  description = "Fallback routing applied when no mapping entry matches a repo. Supports the same destinations structure and per-repo overrides. If null, unmatched repos are silently dropped."
  type = object({
    destinations = list(object({
      workspace = string
      channels  = optional(list(string), [])
    }))
    github_org       = optional(string)
    muted_users      = optional(list(string), [])
    personal_dms     = optional(bool)
    author_dms       = optional(bool)
    mention_dms      = optional(bool)
    ignore_bots      = optional(bool)
    ci_notifications = optional(bool)
    emojis = optional(object({
      opened            = optional(string)
      approved          = optional(string)
      changes_requested = optional(string)
      merged            = optional(string)
      closed            = optional(string)
      ci_pass           = optional(string)
      ci_fail           = optional(string)
      merged_reaction   = optional(string)
    }))
  })
  default = null

  validation {
    condition = var.default_mapping == null ? true : alltrue([
      for destination in var.default_mapping.destinations : contains(keys(var.slack_workspaces), destination.workspace)
    ])
    error_message = "Every default_mapping destination workspace must be a key in slack_workspaces."
  }

  validation {
    condition     = var.default_mapping == null ? true : var.default_mapping.github_org == null || contains(keys(var.github_orgs), var.default_mapping.github_org)
    error_message = "default_mapping.github_org must be a key in github_orgs."
  }
}

# ── User mapping ──────────────────────────────────────────────────────────────────

variable "user_map" {
  description = "Explicit map of GitHub username to Slack user ID, checked first in the resolution chain. GitHub hides user email by default, so automatic email-based resolution only works for members who set a public work email matching Slack. In orgs where email is private, this map is the primary resolution mechanism, not a rare exception. Add entries for anyone whose GitHub email is private or differs from their Slack email."
  type        = map(string)
  default     = {}
}

# ── Lambda ────────────────────────────────────────────────────────────────────────

variable "lambda_runtime" {
  description = "Lambda runtime identifier. Defaults to nodejs24.x (supported until April 2028). Update to a newer runtime when the current one approaches end-of-life."
  type        = string
  default     = "nodejs24.x"
}

variable "lambda_memory_size" {
  description = "Amount of memory in MB allocated to the Lambda function."
  type        = number
  default     = 256

  validation {
    condition     = var.lambda_memory_size >= 128 && var.lambda_memory_size <= 10240
    error_message = "lambda_memory_size must be between 128 and 10240 MB."
  }
}

variable "lambda_timeout" {
  description = "Maximum execution time in seconds for a single Lambda invocation."
  type        = number
  default     = 30

  validation {
    condition     = var.lambda_timeout >= 1 && var.lambda_timeout <= 900
    error_message = "lambda_timeout must be between 1 and 900 seconds."
  }
}

variable "reserved_concurrency" {
  description = "Reserved concurrent executions for the Lambda. Caps blast radius and cost from unauthenticated floods against the public Function URL (requests still fail HMAC, but capping concurrency bounds spend). Set to -1 to leave unreserved (account default)."
  type        = number
  default     = -1

  validation {
    condition     = var.reserved_concurrency == -1 || var.reserved_concurrency >= 0
    error_message = "reserved_concurrency must be -1 or a non-negative number."
  }
}

# ── Observability ─────────────────────────────────────────────────────────────────

variable "log_retention_days" {
  description = "Retention period (days) for the Lambda's CloudWatch log group. Must be a CloudWatch-supported value (1,3,5,7,14,30,60,90,120,150,180,365,...). Defaults to 90."
  type        = number
  default     = 90

  validation {
    condition = contains([
      1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731,
      1096, 1827, 2192, 2557, 2922, 3288, 3653,
    ], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs-supported retention value."
  }
}

variable "log_kms_key_arn" {
  description = "KMS key ARN for encrypting the CloudWatch log group at rest. Leave null (default) to use the AWS-managed CloudWatch Logs key. If you supply a customer-managed key, its key policy must allow the CloudWatch Logs service principal (logs.<region>.amazonaws.com) to use it, scoped with the kms:EncryptionContext:aws:logs:arn condition."
  type        = string
  default     = null
}

variable "alarm_sns_topic_arns" {
  description = "SNS topic ARNs to notify when ReviewBell logs an event_failed processing outcome. When non-empty, the module creates a log metric filter and CloudWatch alarm wired to these topics, so failures returned as HTTP responses by the Function URL are surfaced. When empty (default) no alarm is created."
  type        = list(string)
  default     = []
}

# ── Behaviour defaults ────────────────────────────────────────────────────────────

variable "muted_users" {
  description = "GitHub usernames that will never receive DMs or @mentions regardless of repo. Combined with any per-repo muted_users — a user in either list is muted for that repo."
  type        = list(string)
  default     = []
}

variable "personal_dms" {
  description = "Default for whether a Slack DM is sent to each reviewer when assigned. Can be overridden per mapping rule."
  type        = bool
  default     = true
}

variable "author_dms" {
  description = "Default for whether the PR author receives a Slack DM when someone comments on their PR or submits a review with changes requested. Uses one in-place-updated DM per PR (not a new message per comment). Can be overridden per mapping rule."
  type        = bool
  default     = true
}

variable "mention_dms" {
  description = "Default for whether users explicitly @mentioned in a PR comment or review body receive a Slack DM linking to that comment. Keeps re-looping specific people (reviewers, or others) a deliberate, low-noise action. Skips the comment author (no self-DM), muted_users, and GitHub team mentions (e.g. @org/team). Can be overridden per mapping rule."
  type        = bool
  default     = true
}

variable "ignore_bots" {
  description = "Default for whether events whose sender/author is a GitHub App or bot (sender.type == 'Bot', e.g. dependabot, CI apps, review bots) are ignored entirely — no channel messages, no DMs. Prevents automation from flooding channels. Can be overridden per mapping rule."
  type        = bool
  default     = true
}

variable "ci_notifications" {
  description = "Default for whether CI status (from check_suite/status webhook events) is reflected on the channel message badge using the ci_pass/ci_fail emojis. CI events are only used to update an existing channel message in place (debounced to the latest aggregate result); they never create a message or send DMs. Set false to ignore CI entirely. Can be overridden per mapping rule."
  type        = bool
  default     = true
}

variable "emojis" {
  description = "Default Slack emoji codes for each PR state and event. Use any standard or custom workspace emoji name without colons. Can be overridden per mapping rule for individual repos."
  type = object({
    opened            = optional(string, "yellow_circle")
    approved          = optional(string, "white_check_mark")
    changes_requested = optional(string, "red_circle")
    merged            = optional(string, "tada")
    closed            = optional(string, "no_entry_sign")
    ci_pass           = optional(string, "white_check_mark")
    ci_fail           = optional(string, "x")
    merged_reaction   = optional(string, "tada")
  })
  default = {}
}

# ── Tags ──────────────────────────────────────────────────────────────────────────

variable "tags" {
  description = "Additional tags to apply to all resources."
  type        = map(any)
  default     = {}
}
