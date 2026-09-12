import { Octokit } from "@octokit/rest";
import { AppConfig } from "./types";
import { getCachedUser, putCachedUser } from "./store";
import { lookupByEmail } from "./slack";
import { log } from "./logger";

const octokits = new Map<string, Octokit>();

function octokitFor(token: string, baseUrl: string | null): Octokit {
  const key = `${baseUrl ?? "default"}:${token}`;
  let o = octokits.get(key);
  if (!o) {
    o = new Octokit({
      auth: token,
      ...(baseUrl ? { baseUrl } : {}),
    });
    octokits.set(key, o);
  }
  return o;
}

export interface ResolvedSlackUser {
  slackUserId: string;
  workspace: string;
}

/**
 * Resolve GitHub login → Slack user ID.
 * Priority: user_map → DynamoDB cache → GitHub email → Slack lookupByEmail (per workspace).
 */
export async function resolveGithubToSlack(
  config: AppConfig,
  githubToken: string,
  githubLogin: string,
  workspaceOrder: string[],
): Promise<ResolvedSlackUser | null> {
  const mapped = config.userMap[githubLogin] ?? config.userMap[githubLogin.toLowerCase()];
  if (mapped) {
    // user_map gives Slack ID; pick first workspace that has a bot token
    for (const ws of workspaceOrder) {
      if (config.slackWorkspaces[ws]) {
        return { slackUserId: mapped, workspace: ws };
      }
    }
    if (workspaceOrder.length === 0) {
      const first = Object.keys(config.slackWorkspaces)[0];
      if (first) return { slackUserId: mapped, workspace: first };
    }
  }

  const cached = await getCachedUser(config.tableName, githubLogin);
  if (cached !== undefined) {
    if (!cached.slack_user_id) return null;
    const ws =
      cached.workspace && config.slackWorkspaces[cached.workspace]
        ? cached.workspace
        : workspaceOrder.find((w) => config.slackWorkspaces[w]) ??
          Object.keys(config.slackWorkspaces)[0];
    if (!ws) return null;
    return { slackUserId: cached.slack_user_id, workspace: ws };
  }

  let email: string | null = null;
  try {
    const octokit = octokitFor(githubToken, config.githubApiBaseUrl);
    const { data } = await octokit.users.getByUsername({ username: githubLogin });
    email = data.email ?? null;
  } catch (err) {
    log.warn("github_user_lookup_failed", {
      github_user: githubLogin,
      error_class: (err as Error).name,
    });
  }

  if (email) {
    for (const ws of workspaceOrder) {
      const token = config.slackWorkspaces[ws]?.bot_token;
      if (!token) continue;
      try {
        const slackId = await lookupByEmail(token, email);
        if (slackId) {
          await putCachedUser(config.tableName, githubLogin, slackId, ws);
          return { slackUserId: slackId, workspace: ws };
        }
      } catch (err) {
        log.warn("slack_email_lookup_failed", {
          github_user: githubLogin,
          workspace: ws,
          error_class: (err as Error).name,
        });
      }
    }
  }

  await putCachedUser(config.tableName, githubLogin, null);
  log.warn("unresolved_github_user", { github_user: githubLogin });
  return null;
}
