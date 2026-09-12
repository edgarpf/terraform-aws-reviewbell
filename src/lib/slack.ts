import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { log } from "./logger";

const clients = new Map<string, WebClient>();

export function slackClient(botToken: string): WebClient {
  let c = clients.get(botToken);
  if (!c) {
    c = new WebClient(botToken);
    clients.set(botToken, c);
  }
  return c;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { code?: string; data?: { error?: string; retry_after?: number } };
      const retryAfter = e.data?.retry_after;
      if ((e.code === "slack_webapi_platform_error" && e.data?.error === "ratelimited") || retryAfter) {
        attempt++;
        if (attempt > 3) throw err;
        const waitMs = ((retryAfter ?? 1) + 1) * 1000;
        log.warn("slack_rate_limited", { label, attempt, wait_ms: waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

export async function postMessage(
  botToken: string,
  channel: string,
  text: string,
  blocks: KnownBlock[],
  clientMsgId?: string,
): Promise<string> {
  const client = slackClient(botToken);
  const args = {
    channel,
    text,
    blocks,
    client_msg_id: clientMsgId,
    unfurl_links: false,
    unfurl_media: false,
  } as Parameters<typeof client.chat.postMessage>[0];
  const res = await withRetry(
    () => client.chat.postMessage(args),
    "chat.postMessage",
  );
  if (!res.ts) throw new Error("chat.postMessage returned no ts");
  return res.ts;
}

export async function updateMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string,
  blocks: KnownBlock[],
): Promise<void> {
  const client = slackClient(botToken);
  await withRetry(
    () =>
      client.chat.update({
        channel,
        ts,
        text,
        blocks,
      }),
    "chat.update",
  );
}

export async function openDm(botToken: string, slackUserId: string): Promise<string> {
  const client = slackClient(botToken);
  const res = await withRetry(
    () => client.conversations.open({ users: slackUserId }),
    "conversations.open",
  );
  const channel = res.channel?.id;
  if (!channel) throw new Error("conversations.open returned no channel");
  return channel;
}

export async function addReaction(
  botToken: string,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const client = slackClient(botToken);
  try {
    await withRetry(
      () => client.reactions.add({ channel, timestamp: ts, name: emoji.replace(/:/g, "") }),
      "reactions.add",
    );
  } catch (err: unknown) {
    const e = err as { data?: { error?: string } };
    if (e.data?.error === "already_reacted") return;
    throw err;
  }
}

export async function lookupByEmail(
  botToken: string,
  email: string,
): Promise<string | null> {
  const client = slackClient(botToken);
  try {
    const res = await withRetry(
      () => client.users.lookupByEmail({ email }),
      "users.lookupByEmail",
    );
    return res.user?.id ?? null;
  } catch (err: unknown) {
    const e = err as { data?: { error?: string } };
    if (e.data?.error === "users_not_found") return null;
    throw err;
  }
}

const channelCache = new Map<string, string>();

/** Resolve #name or leave ID as-is. */
export async function resolveChannelId(
  botToken: string,
  channel: string,
): Promise<string> {
  if (!channel.startsWith("#")) return channel;
  const name = channel.slice(1).toLowerCase();
  const cacheKey = `${botToken}:${name}`;
  const cached = channelCache.get(cacheKey);
  if (cached) return cached;

  const client = slackClient(botToken);
  let cursor: string | undefined;
  do {
    const res = await withRetry(
      () =>
        client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          cursor,
          exclude_archived: true,
        }),
      "conversations.list",
    );
    for (const ch of res.channels ?? []) {
      if (ch.name?.toLowerCase() === name && ch.id) {
        channelCache.set(cacheKey, ch.id);
        return ch.id;
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  throw new Error(`channel_not_found:${channel}`);
}
