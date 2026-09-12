# Basic ReviewBell example

This example deploys ReviewBell for a single GitHub org and a single Slack workspace.

```bash
cd examples/basic
terraform init
terraform apply
```

Then:

1. Invite the Slack bot to `#frontend-prs`
2. Create a GitHub webhook pointing at the `webhook_url` output
3. Optionally fill `user_map` with GitHub → Slack user IDs
