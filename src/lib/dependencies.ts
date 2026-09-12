import type { KnownBlock } from "@slack/types";
import type { AppConfig, PrRecord } from "./types";

export type DeliveryClaim = "claimed" | "completed" | "in_progress";

export interface EffectRecord {
  message_ts?: string;
}

export interface StorePort {
  claimDelivery(
    table: string,
    guid: string,
    now: number,
    leaseSeconds: number,
    leaseId: string,
  ): Promise<DeliveryClaim>;
  completeDelivery(table: string, guid: string, now: number, leaseId: string): Promise<void>;
  releaseDelivery(table: string, guid: string, leaseId: string): Promise<void>;
  getPr(table: string, repo: string, number: number): Promise<PrRecord | null>;
  createPrIfAbsent(
    table: string,
    record: Omit<PrRecord, "expires_at"> & { expires_at?: number },
  ): Promise<{ created: boolean; record: PrRecord }>;
  putPr(table: string, record: PrRecord): Promise<void>;
  getEffect(table: string, deliveryId: string, effectId: string): Promise<EffectRecord | null>;
  putEffect(
    table: string,
    deliveryId: string,
    effectId: string,
    result: EffectRecord,
  ): Promise<void>;
}

export interface SlackPort {
  postMessage(
    botToken: string,
    channel: string,
    text: string,
    blocks: KnownBlock[],
    clientMsgId?: string,
  ): Promise<string>;
  updateMessage(
    botToken: string,
    channel: string,
    ts: string,
    text: string,
    blocks: KnownBlock[],
  ): Promise<void>;
  openDm(botToken: string, slackUserId: string): Promise<string>;
  addReaction(botToken: string, channel: string, ts: string, emoji: string): Promise<void>;
  resolveChannelId(botToken: string, channel: string): Promise<string>;
}

export interface ResolvedSlackUser {
  slackUserId: string;
  workspace: string;
}

export interface UserResolverPort {
  resolve(
    config: AppConfig,
    githubToken: string,
    githubLogin: string,
    workspaceOrder: string[],
  ): Promise<ResolvedSlackUser | null>;
}

export interface NotificationDependencies {
  store: StorePort;
  slack: SlackPort;
  users: UserResolverPort;
}

export interface ProcessDependencies {
  store: StorePort;
  notifications: NotificationDependencies;
}
