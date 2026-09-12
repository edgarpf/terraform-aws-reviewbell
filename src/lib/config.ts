import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { log } from "./logger";
import {
  AppConfig,
  DEFAULT_EMOJIS,
  Destination,
  Emojis,
  GithubOrgCreds,
  MappingRule,
  mergeEmojis,
  ResolvedBehaviour,
  SlackWorkspace,
} from "./types";

const ssm = new SSMClient({});

let cachedSecrets: {
  githubOrgs: Record<string, GithubOrgCreds>;
  slackWorkspaces: Record<string, SlackWorkspace>;
} | null = null;

async function getSecureString(name: string): Promise<string> {
  const res = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (!res.Parameter?.Value) {
    throw new Error(`SSM parameter ${name} is empty`);
  }
  return res.Parameter.Value;
}

async function loadSecrets(): Promise<{
  githubOrgs: Record<string, GithubOrgCreds>;
  slackWorkspaces: Record<string, SlackWorkspace>;
}> {
  if (cachedSecrets) return cachedSecrets;

  const githubParam = process.env.GITHUB_ORGS_PARAM;
  const slackParam = process.env.SLACK_WORKSPACES_PARAM;
  if (!githubParam || !slackParam) {
    throw new Error("GITHUB_ORGS_PARAM and SLACK_WORKSPACES_PARAM are required");
  }

  const [githubRaw, slackRaw] = await Promise.all([
    getSecureString(githubParam),
    getSecureString(slackParam),
  ]);

  cachedSecrets = {
    githubOrgs: JSON.parse(githubRaw) as Record<string, GithubOrgCreds>,
    slackWorkspaces: JSON.parse(slackRaw) as Record<string, SlackWorkspace>,
  };
  log.info("secrets_loaded", {
    github_org_count: Object.keys(cachedSecrets.githubOrgs).length,
    slack_workspace_count: Object.keys(cachedSecrets.slackWorkspaces).length,
  });
  return cachedSecrets;
}

function parseJsonEnv<T>(key: string, fallback: T): T {
  const raw = process.env[key];
  if (raw === undefined || raw === "" || raw === "null") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    log.warn("invalid_json_env", { key });
    return fallback;
  }
}

function parseBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export async function loadConfig(): Promise<AppConfig> {
  const secrets = await loadSecrets();
  const tableName = process.env.PR_TABLE;
  if (!tableName) throw new Error("PR_TABLE is required");

  const defaultGithubOrg = process.env.DEFAULT_GITHUB_ORG || null;
  const githubApiBaseUrl = process.env.GITHUB_API_BASE_URL || null;

  return {
    tableName,
    githubOrgs: secrets.githubOrgs,
    slackWorkspaces: secrets.slackWorkspaces,
    defaultGithubOrg: defaultGithubOrg === "" ? null : defaultGithubOrg,
    githubApiBaseUrl: githubApiBaseUrl === "" ? null : githubApiBaseUrl,
    mappings: parseJsonEnv<MappingRule[]>("MAPPINGS", []),
    defaultMapping: parseJsonEnv<MappingRule | null>("DEFAULT_MAPPING", null),
    userMap: parseJsonEnv<Record<string, string>>("USER_MAP", {}),
    mutedUsers: parseJsonEnv<string[]>("MUTED_USERS", []),
    personalDms: parseBool("PERSONAL_DMS", true),
    authorDms: parseBool("AUTHOR_DMS", true),
    mentionDms: parseBool("MENTION_DMS", true),
    ignoreBots: parseBool("IGNORE_BOTS", true),
    ciNotifications: parseBool("CI_NOTIFICATIONS", true),
    emojis: {
      ...DEFAULT_EMOJIS,
      ...parseJsonEnv<Partial<Emojis>>("EMOJIS", {}),
    },
  };
}

/** Match precedence: exact org/repo > org/* > * > default_mapping. Case-insensitive. */
export function resolveMapping(
  config: AppConfig,
  fullRepo: string,
): ResolvedBehaviour | null {
  const lower = fullRepo.toLowerCase();
  const [org] = lower.split("/");

  let matched: MappingRule | null = null;
  let score = -1;

  for (const rule of config.mappings) {
    const pattern = (rule.repo ?? "").toLowerCase();
    let s = -1;
    if (pattern === lower) s = 3;
    else if (pattern === `${org}/*`) s = 2;
    else if (pattern === "*") s = 1;
    if (s > score) {
      score = s;
      matched = rule;
    }
  }

  if (!matched) {
    if (!config.defaultMapping) return null;
    matched = config.defaultMapping;
  }

  const orgKeys = Object.keys(config.githubOrgs);
  const githubOrg =
    matched.github_org ??
    config.defaultGithubOrg ??
    (orgKeys.length === 1 ? orgKeys[0] : null);

  if (!githubOrg || !config.githubOrgs[githubOrg]) {
    log.warn("unresolved_github_org", { repo: fullRepo });
    return null;
  }

  const destinations: Destination[] = (matched.destinations ?? []).map((d) => ({
    workspace: d.workspace,
    channels: d.channels ?? [],
  }));

  const muted = new Set<string>([
    ...config.mutedUsers.map((u) => u.toLowerCase()),
    ...(matched.muted_users ?? []).map((u) => u.toLowerCase()),
  ]);

  const ruleEmojis = matched.emojis;

  return {
    destinations,
    githubOrg,
    mutedUsers: muted,
    personalDms: matched.personal_dms ?? config.personalDms,
    authorDms: matched.author_dms ?? config.authorDms,
    mentionDms: matched.mention_dms ?? config.mentionDms,
    ignoreBots: matched.ignore_bots ?? config.ignoreBots,
    ciNotifications: matched.ci_notifications ?? config.ciNotifications,
    emojisForWorkspace: (workspace: string) =>
      mergeEmojis(config.emojis, config.slackWorkspaces[workspace]?.emojis, ruleEmojis),
  };
}

export function isMuted(behaviour: ResolvedBehaviour, githubLogin: string): boolean {
  return behaviour.mutedUsers.has(githubLogin.toLowerCase());
}
