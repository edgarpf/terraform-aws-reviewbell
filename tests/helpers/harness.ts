import { createHmac } from "crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { KnownBlock } from "@slack/types";
import { authenticateWebhook } from "../../src/lib/auth";
import type {
  DeliveryClaim,
  EffectRecord,
  NotificationDependencies,
  ProcessDependencies,
  SlackPort,
  StorePort,
} from "../../src/lib/dependencies";
import { createHandler } from "../../src/index";
import { processEvent } from "../../src/process";
import { prKey } from "../../src/lib/store";
import { DEFAULT_EMOJIS, type AppConfig, type PrRecord } from "../../src/lib/types";

export class MemoryStore implements StorePort {
  readonly prs = new Map<string, PrRecord>();
  readonly deliveries = new Map<
    string,
    { state: "processing" | "completed"; lease: number; leaseId: string }
  >();
  readonly effects = new Map<string, EffectRecord>();

  async claimDelivery(
    _table: string,
    guid: string,
    now: number,
    leaseSeconds: number,
    leaseId: string,
  ): Promise<DeliveryClaim> {
    const current = this.deliveries.get(guid);
    if (current?.state === "completed") return "completed";
    if (current?.state === "processing" && current.lease >= now) return "in_progress";
    this.deliveries.set(guid, {
      state: "processing",
      lease: now + leaseSeconds,
      leaseId,
    });
    return "claimed";
  }

  async completeDelivery(
    _table: string,
    guid: string,
    _now: number,
    leaseId: string,
  ): Promise<void> {
    if (this.deliveries.get(guid)?.leaseId !== leaseId) return;
    this.deliveries.set(guid, { state: "completed", lease: 0, leaseId });
  }

  async releaseDelivery(_table: string, guid: string, leaseId: string): Promise<void> {
    const delivery = this.deliveries.get(guid);
    if (delivery?.state === "processing" && delivery.leaseId === leaseId) {
      this.deliveries.delete(guid);
    }
  }

  async getPr(_table: string, repo: string, number: number): Promise<PrRecord | null> {
    return this.prs.get(prKey(repo, number)) ?? null;
  }

  async createPrIfAbsent(
    _table: string,
    record: Omit<PrRecord, "expires_at"> & { expires_at?: number },
  ): Promise<{ created: boolean; record: PrRecord }> {
    const existing = this.prs.get(record.repo_pr);
    if (existing) return { created: false, record: existing };
    const created = {
      ...record,
      expires_at: record.expires_at ?? 9_999_999,
      version: 1,
    } as PrRecord;
    this.prs.set(record.repo_pr, created);
    return { created: true, record: created };
  }

  async putPr(_table: string, record: PrRecord): Promise<void> {
    const existing = this.prs.get(record.repo_pr);
    if (existing && (record.version ?? 0) !== (existing.version ?? 0)) {
      const conflict = new Error("version conflict");
      conflict.name = "ConditionalCheckFailedException";
      throw conflict;
    }
    record.version = (record.version ?? 0) + 1;
    record.expires_at = 9_999_999;
    this.prs.set(record.repo_pr, record);
  }

  async getEffect(
    _table: string,
    deliveryId: string,
    effectId: string,
  ): Promise<EffectRecord | null> {
    return this.effects.get(`${deliveryId}:${effectId}`) ?? null;
  }

  async putEffect(
    _table: string,
    deliveryId: string,
    effectId: string,
    result: EffectRecord,
  ): Promise<void> {
    this.effects.set(`${deliveryId}:${effectId}`, result);
  }
}

export interface SlackCall {
  kind: "post" | "update" | "open" | "reaction";
  channel?: string;
  text?: string;
  blocks?: KnownBlock[];
  clientMsgId?: string;
  user?: string;
  ts?: string;
  emoji?: string;
}

export class RecordingSlack implements SlackPort {
  readonly calls: SlackCall[] = [];
  private sequence = 0;
  private readonly byClientId = new Map<string, string>();
  failNextPost = false;
  failPostAt = new Set<number>();
  private postAttempts = 0;

  async postMessage(
    _botToken: string,
    channel: string,
    text: string,
    blocks: KnownBlock[],
    clientMsgId?: string,
  ): Promise<string> {
    this.postAttempts += 1;
    if (this.failNextPost || this.failPostAt.has(this.postAttempts)) {
      this.failNextPost = false;
      throw new Error("slack unavailable");
    }
    if (clientMsgId && this.byClientId.has(clientMsgId)) return this.byClientId.get(clientMsgId)!;
    const ts = `${++this.sequence}.000001`;
    this.calls.push({ kind: "post", channel, text, blocks, clientMsgId, ts });
    if (clientMsgId) this.byClientId.set(clientMsgId, ts);
    return ts;
  }

  async updateMessage(
    _botToken: string,
    channel: string,
    ts: string,
    text: string,
    blocks: KnownBlock[],
  ): Promise<void> {
    this.calls.push({ kind: "update", channel, ts, text, blocks });
  }

  async openDm(_botToken: string, slackUserId: string): Promise<string> {
    this.calls.push({ kind: "open", user: slackUserId });
    return `D_${slackUserId}`;
  }

  async addReaction(
    _botToken: string,
    channel: string,
    ts: string,
    emoji: string,
  ): Promise<void> {
    this.calls.push({ kind: "reaction", channel, ts, emoji });
  }

  async resolveChannelId(_botToken: string, channel: string): Promise<string> {
    return channel.startsWith("#") ? `C_${channel.slice(1).toUpperCase()}` : channel;
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    tableName: "reviewbell-test",
    githubOrgs: {
      acme: { webhook_secret: "acme-secret", token: "github-token" },
    },
    slackWorkspaces: {
      eng: { bot_token: "slack-token" },
    },
    defaultGithubOrg: "acme",
    githubApiBaseUrl: null,
    mappings: [
      {
        repo: "acme/widget",
        destinations: [{ workspace: "eng", channels: ["#reviews"] }],
      },
    ],
    defaultMapping: null,
    userMap: {
      alice: "U_ALICE",
      bob: "U_BOB",
      carol: "U_CAROL",
      dana: "U_DANA",
    },
    mutedUsers: [],
    personalDms: true,
    authorDms: true,
    mentionDms: true,
    ignoreBots: true,
    ciNotifications: true,
    emojis: DEFAULT_EMOJIS,
    ...overrides,
  };
}

export function lambdaEvent(
  eventName: string,
  payload: Record<string, unknown>,
  options: {
    deliveryId?: string;
    secret?: string;
    method?: string;
    base64?: boolean;
    signature?: string | null;
    rawBody?: string;
  } = {},
): LambdaFunctionURLEvent {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const signature =
    options.signature === null
      ? undefined
      : (options.signature ??
        `sha256=${createHmac("sha256", options.secret ?? "acme-secret").update(rawBody).digest("hex")}`);
  const headers: Record<string, string> = {
    "x-github-delivery": options.deliveryId ?? `${eventName}-delivery`,
    "x-github-event": eventName,
  };
  if (signature) headers["x-hub-signature-256"] = signature;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "anonymous",
      apiId: "test",
      domainName: "test.lambda-url.us-east-1.on.aws",
      domainPrefix: "test",
      http: {
        method: options.method ?? "POST",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body: options.base64 ? Buffer.from(rawBody).toString("base64") : rawBody,
    isBase64Encoded: options.base64 ?? false,
  };
}

export class ReviewBellHarness {
  readonly store = new MemoryStore();
  readonly slack = new RecordingSlack();
  readonly config: AppConfig;
  now = 1_800_000_000;

  readonly dependencies: ProcessDependencies;
  readonly handler: ReturnType<typeof createHandler>;

  constructor(config: AppConfig = testConfig()) {
    this.config = config;
    const notifications: NotificationDependencies = {
      store: this.store,
      slack: this.slack,
      users: {
        resolve: async (appConfig, _token, login, workspaces) => {
          const slackUserId =
            appConfig.userMap[login] ??
            appConfig.userMap[login.toLowerCase()] ??
            (login ? `U_${login.toUpperCase()}` : undefined);
          const workspace = workspaces.find((candidate) => appConfig.slackWorkspaces[candidate]);
          return slackUserId && workspace ? { slackUserId, workspace } : null;
        },
      },
    };
    this.dependencies = { store: this.store, notifications };
    this.handler = createHandler({
      loadConfig: async () => this.config,
      authenticateWebhook,
      processEvent,
      processDependencies: this.dependencies,
      store: this.store,
      now: () => this.now,
      newLeaseId: (deliveryId) => `${deliveryId}:${this.now}`,
    });
  }

  async send(
    eventName: string,
    payload: Record<string, unknown>,
    options: Parameters<typeof lambdaEvent>[2] = {},
  ) {
    return this.handler(lambdaEvent(eventName, payload, options));
  }

  pr(repo = "acme/widget", number = 42): PrRecord | null {
    return this.store.prs.get(prKey(repo, number)) ?? null;
  }

  posts() {
    return this.slack.calls.filter((call) => call.kind === "post");
  }

  updates() {
    return this.slack.calls.filter((call) => call.kind === "update");
  }

  callsByKind(kind: SlackCall["kind"]) {
    return this.slack.calls.filter((call) => call.kind === kind);
  }

  seedPr(overrides: Partial<PrRecord> = {}): PrRecord {
    const record = {
      repo_pr: "acme/widget#42",
      routes: [],
      dm_routes: [],
      reviewers: [],
      status: "open" as const,
      ci_status: null,
      ci_suites: {},
      title: "Improve ReviewBell",
      html_url: "https://github.com/acme/widget/pull/42",
      author: "alice",
      expires_at: 9_999_999,
      version: 1,
      ...overrides,
    };
    this.store.prs.set(record.repo_pr, record);
    return record;
  }
}
