import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DeliveryClaim, EffectRecord } from "./dependencies";
import { AuthorDm, ChannelRoute, DmRoute, PrRecord, ReviewerState } from "./types";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const DAY = 24 * 60 * 60;
const PR_TTL_SECONDS = 30 * DAY;
const DELIVERY_TTL_SECONDS = 1 * DAY;
const USER_CACHE_TTL_SECONDS = 7 * DAY;
const NEGATIVE_CACHE_TTL_SECONDS = 1 * DAY;

export function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export function deliveryKey(guid: string): string {
  return `delivery#${guid}`;
}

export function userKey(login: string): string {
  return `user#${login.toLowerCase()}`;
}

export function effectKey(deliveryId: string, effectId: string): string {
  return `effect#${deliveryId}#${effectId}`;
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export async function claimDelivery(
  table: string,
  guid: string,
  now: number,
  leaseSeconds: number,
  leaseId: string,
): Promise<DeliveryClaim> {
  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          repo_pr: deliveryKey(guid),
          state: "processing",
          lease_id: leaseId,
          lease_expires_at: now + leaseSeconds,
          expires_at: now + DELIVERY_TTL_SECONDS,
        },
        ConditionExpression:
          "attribute_not_exists(repo_pr) OR (#state = :processing AND lease_expires_at < :now)",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":processing": "processing", ":now": now },
      }),
    );
    return "claimed";
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    const res = await client.send(
      new GetCommand({ TableName: table, Key: { repo_pr: deliveryKey(guid) } }),
    );
    return res.Item?.state === "completed" ? "completed" : "in_progress";
  }
}

export async function completeDelivery(
  table: string,
  guid: string,
  now: number,
  leaseId: string,
): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { repo_pr: deliveryKey(guid) },
      UpdateExpression:
        "SET #state = :completed, expires_at = :expires REMOVE lease_expires_at, lease_id",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":completed": "completed",
        ":expires": now + DELIVERY_TTL_SECONDS,
        ":processing": "processing",
        ":lease_id": leaseId,
      },
      ConditionExpression: "#state = :processing AND lease_id = :lease_id",
    }),
  );
}

export async function releaseDelivery(
  table: string,
  guid: string,
  leaseId: string,
): Promise<void> {
  try {
    await client.send(
      new DeleteCommand({
        TableName: table,
        Key: { repo_pr: deliveryKey(guid) },
        ConditionExpression: "#state = :processing AND lease_id = :lease_id",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":processing": "processing",
          ":lease_id": leaseId,
        },
      }),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
  }
}

/** Compatibility helpers retained for downstream imports. */
export async function isDeliveryDone(table: string, guid: string): Promise<boolean> {
  const res = await client.send(
    new GetCommand({ TableName: table, Key: { repo_pr: deliveryKey(guid) } }),
  );
  return res.Item?.state === "completed" || Boolean(res.Item?.done);
}

export async function markDeliveryDone(table: string, guid: string): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        repo_pr: deliveryKey(guid),
        state: "completed",
        done: true,
        expires_at: nowEpoch() + DELIVERY_TTL_SECONDS,
      },
    }),
  );
}

export async function getPr(table: string, repo: string, number: number): Promise<PrRecord | null> {
  const res = await client.send(
    new GetCommand({ TableName: table, Key: { repo_pr: prKey(repo, number) } }),
  );
  return (res.Item as PrRecord) ?? null;
}

/** First-writer-wins create. Returns true if this caller created the item. */
export async function createPrIfAbsent(
  table: string,
  record: Omit<PrRecord, "expires_at"> & { expires_at?: number },
): Promise<{ created: boolean; record: PrRecord }> {
  const item: PrRecord = {
    ...record,
    expires_at: record.expires_at ?? nowEpoch() + PR_TTL_SECONDS,
    version: record.version ?? 1,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: table,
        Item: item,
        ConditionExpression: "attribute_not_exists(repo_pr)",
      }),
    );
    return { created: true, record: item };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "ConditionalCheckFailedException") {
      const existing = await getPr(
        table,
        item.repo_pr.split("#")[0],
        Number(item.repo_pr.split("#")[1]),
      );
      if (!existing) throw err;
      return { created: false, record: existing };
    }
    throw err;
  }
}

export async function putPr(table: string, record: PrRecord): Promise<void> {
  const expectedVersion = record.version ?? 0;
  const nextVersion = expectedVersion + 1;
  const expiresAt = nowEpoch() + PR_TTL_SECONDS;
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...record,
        expires_at: expiresAt,
        version: nextVersion,
      },
      ConditionExpression:
        expectedVersion === 0 ? "attribute_not_exists(#version)" : "#version = :expected_version",
      ExpressionAttributeNames: { "#version": "version" },
      ...(expectedVersion === 0
        ? {}
        : { ExpressionAttributeValues: { ":expected_version": expectedVersion } }),
    }),
  );
  record.version = nextVersion;
  record.expires_at = expiresAt;
}

export async function getEffect(
  table: string,
  deliveryId: string,
  effectId: string,
): Promise<EffectRecord | null> {
  const res = await client.send(
    new GetCommand({ TableName: table, Key: { repo_pr: effectKey(deliveryId, effectId) } }),
  );
  if (!res.Item) return null;
  return { message_ts: res.Item.message_ts as string | undefined };
}

export async function putEffect(
  table: string,
  deliveryId: string,
  effectId: string,
  result: EffectRecord,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        repo_pr: effectKey(deliveryId, effectId),
        ...result,
        expires_at: nowEpoch() + DELIVERY_TTL_SECONDS,
      },
    }),
  );
}

export async function updatePrFields(
  table: string,
  repo: string,
  number: number,
  fields: Partial<
    Pick<
      PrRecord,
      | "routes"
      | "dm_routes"
      | "author_dm"
      | "reviewers"
      | "status"
      | "ci_status"
      | "ci_suites"
      | "title"
      | "html_url"
      | "author"
      | "expires_at"
    >
  >,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const nk = `#f${i}`;
    const vk = `:v${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
    i++;
  }
  if (sets.length === 0) return;
  await client.send(
    new UpdateCommand({
      TableName: table,
      Key: { repo_pr: prKey(repo, number) },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export interface CachedUser {
  slack_user_id: string | null;
  workspace?: string;
}

export async function getCachedUser(
  table: string,
  login: string,
): Promise<CachedUser | undefined> {
  const res = await client.send(
    new GetCommand({ TableName: table, Key: { repo_pr: userKey(login) } }),
  );
  if (!res.Item) return undefined;
  return {
    slack_user_id: (res.Item.slack_user_id as string | null) ?? null,
    workspace: res.Item.workspace as string | undefined,
  };
}

export async function putCachedUser(
  table: string,
  login: string,
  slackUserId: string | null,
  workspace?: string,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: {
        repo_pr: userKey(login),
        slack_user_id: slackUserId,
        workspace,
        expires_at:
          nowEpoch() + (slackUserId ? USER_CACHE_TTL_SECONDS : NEGATIVE_CACHE_TTL_SECONDS),
      },
    }),
  );
}

export function emptyPrRecord(
  repo: string,
  number: number,
  extras: Partial<PrRecord> = {},
): PrRecord {
  return {
    repo_pr: prKey(repo, number),
    routes: [],
    dm_routes: [],
    reviewers: [],
    status: "open",
    ci_status: null,
    ci_suites: {},
    expires_at: nowEpoch() + PR_TTL_SECONDS,
    ...extras,
  };
}

export type { ChannelRoute, DmRoute, AuthorDm, ReviewerState };
