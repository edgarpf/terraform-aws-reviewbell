export interface Emojis {
  opened: string;
  approved: string;
  changes_requested: string;
  merged: string;
  closed: string;
  ci_pass: string;
  ci_fail: string;
  merged_reaction: string;
}

export interface Destination {
  workspace: string;
  channels: string[];
}

export interface MappingRule {
  repo?: string;
  destinations: Destination[];
  github_org?: string;
  muted_users?: string[];
  personal_dms?: boolean;
  author_dms?: boolean;
  mention_dms?: boolean;
  ignore_bots?: boolean;
  ci_notifications?: boolean;
  emojis?: Partial<Emojis>;
}

export interface GithubOrgCreds {
  webhook_secret: string;
  token: string;
}

export interface SlackWorkspace {
  bot_token: string;
  emojis?: Partial<Emojis>;
}

export interface AppConfig {
  tableName: string;
  githubOrgs: Record<string, GithubOrgCreds>;
  slackWorkspaces: Record<string, SlackWorkspace>;
  defaultGithubOrg: string | null;
  githubApiBaseUrl: string | null;
  mappings: MappingRule[];
  defaultMapping: MappingRule | null;
  userMap: Record<string, string>;
  mutedUsers: string[];
  personalDms: boolean;
  authorDms: boolean;
  mentionDms: boolean;
  ignoreBots: boolean;
  ciNotifications: boolean;
  emojis: Emojis;
}

export interface ResolvedBehaviour {
  destinations: Destination[];
  githubOrg: string;
  mutedUsers: Set<string>;
  personalDms: boolean;
  authorDms: boolean;
  mentionDms: boolean;
  ignoreBots: boolean;
  ciNotifications: boolean;
  emojisForWorkspace: (workspace: string) => Emojis;
}

export type ReviewerStatus = "pending" | "approved" | "changes_requested" | "commented";

export interface ReviewerState {
  github: string;
  status: ReviewerStatus;
  round: number;
}

export interface ChannelRoute {
  workspace: string;
  channel: string;
  message_ts: string;
}

export interface DmRoute {
  workspace: string;
  slack_user_id: string;
  message_ts?: string;
  role: "reviewer" | "author" | "mention";
  github: string;
  notified_round?: number;
}

export interface AuthorDm {
  workspace: string;
  slack_user_id: string;
  message_ts: string;
}

export type PrStatus = "open" | "draft" | "merged" | "closed";
export type CiStatus = "pass" | "fail" | "pending" | null;

export interface PrRecord {
  repo_pr: string;
  routes: ChannelRoute[];
  dm_routes: DmRoute[];
  author_dm?: AuthorDm;
  reviewers: ReviewerState[];
  status: PrStatus;
  ci_status: CiStatus;
  ci_suites?: Record<string, CiStatus>;
  title?: string;
  html_url?: string;
  author?: string;
  expires_at: number;
  version?: number;
}

export const DEFAULT_EMOJIS: Emojis = {
  opened: "yellow_circle",
  approved: "white_check_mark",
  changes_requested: "red_circle",
  merged: "tada",
  closed: "no_entry_sign",
  ci_pass: "white_check_mark",
  ci_fail: "x",
  merged_reaction: "tada",
};

export function mergeEmojis(...layers: Array<Partial<Emojis> | undefined>): Emojis {
  return {
    ...DEFAULT_EMOJIS,
    ...layers.reduce<Partial<Emojis>>((acc, layer) => ({ ...acc, ...(layer ?? {}) }), {}),
  };
}
