import { createHash } from "crypto";
import type { KnownBlock } from "@slack/types";
import { AppConfig, PrRecord, ResolvedBehaviour, ReviewerState } from "./types";
import { isMuted } from "./config";
import {
  buildAuthorDmBlocks,
  buildChannelBlocks,
  buildMentionDmBlocks,
  buildReviewerDmBlocks,
} from "./messages";
import { log } from "./logger";
import type { NotificationDependencies } from "./dependencies";
import { productionNotifications } from "./runtime";

interface BaseMeta {
  title: string;
  number: number;
  htmlUrl: string;
  repo: string;
  deliveryId: string;
}

function clientMessageId(deliveryId: string, effectId: string): string {
  const hex = createHash("sha256").update(`${deliveryId}:${effectId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function postMessageOnce(
  deps: NotificationDependencies,
  config: AppConfig,
  deliveryId: string,
  effectId: string,
  botToken: string,
  channel: string,
  text: string,
  blocks: KnownBlock[],
): Promise<string> {
  if (deliveryId !== "unknown") {
    const prior = await deps.store.getEffect(config.tableName, deliveryId, effectId);
    if (prior?.message_ts) return prior.message_ts;
  }
  const ts = await deps.slack.postMessage(
    botToken,
    channel,
    text,
    blocks,
    deliveryId === "unknown" ? undefined : clientMessageId(deliveryId, effectId),
  );
  if (deliveryId !== "unknown") {
    await deps.store.putEffect(config.tableName, deliveryId, effectId, { message_ts: ts });
  }
  return ts;
}

async function reviewerMentions(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  workspace: string,
  reviewers: ReviewerState[],
  deps: NotificationDependencies,
): Promise<Record<string, string> | undefined> {
  if (behaviour.personalDms) return undefined;
  const mentions: Record<string, string> = {};
  for (const reviewer of reviewers) {
    const resolved = await deps.users.resolve(config, githubToken, reviewer.github, [workspace]);
    if (resolved?.workspace === workspace) mentions[reviewer.github] = resolved.slackUserId;
  }
  return mentions;
}

export async function ensureChannelMessages(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  pr: PrRecord,
  meta: BaseMeta & { author: string },
  deps: NotificationDependencies = productionNotifications,
): Promise<PrRecord> {
  const updated = {
    ...pr,
    routes: [...pr.routes],
    title: meta.title,
    html_url: meta.htmlUrl,
    author: meta.author,
  };
  await deps.store.putPr(config.tableName, updated);

  for (const dest of behaviour.destinations) {
    const ws = config.slackWorkspaces[dest.workspace];
    if (!ws) continue;
    const emojis = behaviour.emojisForWorkspace(dest.workspace);
    const slackMentions = await reviewerMentions(
      config,
      behaviour,
      githubToken,
      dest.workspace,
      updated.reviewers,
      deps,
    );
    const { text, blocks } = buildChannelBlocks({
      title: meta.title,
      number: meta.number,
      htmlUrl: meta.htmlUrl,
      repo: meta.repo,
      author: meta.author,
      status: updated.status,
      reviewers: updated.reviewers,
      ci: updated.ci_status,
      emojis,
      personalDms: behaviour.personalDms,
      slackMentions,
    });

    for (const channelRef of dest.channels) {
      const existing = updated.routes.find(
        (route) => route.workspace === dest.workspace && route.channel === channelRef,
      );
      try {
        const channelId = await deps.slack.resolveChannelId(ws.bot_token, channelRef);
        if (existing?.message_ts) {
          await deps.slack.updateMessage(
            ws.bot_token,
            channelId,
            existing.message_ts,
            text,
            blocks,
          );
        } else {
          const effectId = `channel:${dest.workspace}:${channelRef}`;
          const ts = await postMessageOnce(
            deps,
            config,
            meta.deliveryId,
            effectId,
            ws.bot_token,
            channelId,
            text,
            blocks,
          );
          updated.routes.push({
            workspace: dest.workspace,
            channel: channelRef,
            message_ts: ts,
          });
          await deps.store.putPr(config.tableName, updated);
        }
      } catch (err) {
        log.error("channel_message_failed", {
          workspace: dest.workspace,
          channel: channelRef,
          error_class: (err as Error).name,
          outcome: "error",
        });
        throw err;
      }
    }
  }
  return updated;
}

export async function refreshChannelMessages(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  pr: PrRecord,
  deps: NotificationDependencies = productionNotifications,
): Promise<void> {
  if (!pr.title || !pr.html_url || !pr.author) return;
  const number = Number(pr.repo_pr.split("#")[1]);
  const repo = pr.repo_pr.split("#")[0];

  for (const route of pr.routes) {
    const ws = config.slackWorkspaces[route.workspace];
    if (!ws) continue;
    const emojis = behaviour.emojisForWorkspace(route.workspace);
    const slackMentions = await reviewerMentions(
      config,
      behaviour,
      githubToken,
      route.workspace,
      pr.reviewers,
      deps,
    );
    const { text, blocks } = buildChannelBlocks({
      title: pr.title,
      number,
      htmlUrl: pr.html_url,
      repo,
      author: pr.author,
      status: pr.status,
      reviewers: pr.reviewers,
      ci: pr.ci_status,
      emojis,
      personalDms: behaviour.personalDms,
      slackMentions,
    });
    try {
      const channelId = await deps.slack.resolveChannelId(ws.bot_token, route.channel);
      await deps.slack.updateMessage(ws.bot_token, channelId, route.message_ts, text, blocks);
    } catch (err) {
      log.error("channel_update_failed", {
        workspace: route.workspace,
        channel: route.channel,
        error_class: (err as Error).name,
      });
      throw err;
    }
  }
}

export async function reactMerged(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  pr: PrRecord,
  deps: NotificationDependencies = productionNotifications,
): Promise<void> {
  for (const route of pr.routes) {
    const ws = config.slackWorkspaces[route.workspace];
    if (!ws) continue;
    const emojis = behaviour.emojisForWorkspace(route.workspace);
    try {
      const channelId = await deps.slack.resolveChannelId(ws.bot_token, route.channel);
      await deps.slack.addReaction(
        ws.bot_token,
        channelId,
        route.message_ts,
        emojis.merged_reaction,
      );
    } catch (err) {
      log.warn("merged_reaction_failed", {
        workspace: route.workspace,
        error_class: (err as Error).name,
      });
    }
  }
}

export async function sendReviewerDm(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  pr: PrRecord,
  reviewerLogin: string,
  meta: BaseMeta & { author: string },
  opts: { reRequest: boolean; round: number },
  deps: NotificationDependencies = productionNotifications,
): Promise<PrRecord> {
  if (!behaviour.personalDms) return pr;
  if (isMuted(behaviour, reviewerLogin)) return pr;
  if (reviewerLogin.toLowerCase() === meta.author.toLowerCase()) return pr;

  const existingDm = pr.dm_routes.find(
    (route) =>
      route.role === "reviewer" &&
      route.github.toLowerCase() === reviewerLogin.toLowerCase(),
  );
  if (existingDm && (existingDm.notified_round ?? 0) >= opts.round) {
    log.info("reviewer_dm_dedup", {
      github_user: reviewerLogin,
      round: opts.round,
      decision: "skip_already_notified",
    });
    return pr;
  }

  const workspaces = behaviour.destinations.map((destination) => destination.workspace);
  const resolved = await deps.users.resolve(config, githubToken, reviewerLogin, workspaces);
  if (!resolved) return pr;
  const ws = config.slackWorkspaces[resolved.workspace];
  if (!ws) return pr;

  const { text, blocks } = buildReviewerDmBlocks({ ...meta, reRequest: opts.reRequest });
  try {
    const dmChannel = await deps.slack.openDm(ws.bot_token, resolved.slackUserId);
    const ts = await postMessageOnce(
      deps,
      config,
      meta.deliveryId,
      `reviewer:${reviewerLogin.toLowerCase()}:round:${opts.round}`,
      ws.bot_token,
      dmChannel,
      text,
      blocks,
    );
    const next = { ...pr, dm_routes: [...pr.dm_routes] };
    const idx = next.dm_routes.findIndex(
      (route) =>
        route.role === "reviewer" &&
        route.github.toLowerCase() === reviewerLogin.toLowerCase(),
    );
    const entry = {
      workspace: resolved.workspace,
      slack_user_id: resolved.slackUserId,
      message_ts: ts,
      role: "reviewer" as const,
      github: reviewerLogin,
      notified_round: opts.round,
    };
    if (idx >= 0) next.dm_routes[idx] = entry;
    else next.dm_routes.push(entry);
    await deps.store.putPr(config.tableName, next);
    log.info("reviewer_dm_sent", { github_user: reviewerLogin, round: opts.round });
    return next;
  } catch (err) {
    log.error("reviewer_dm_failed", {
      github_user: reviewerLogin,
      error_class: (err as Error).name,
    });
    throw err;
  }
}

export async function upsertAuthorDm(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  pr: PrRecord,
  authorLogin: string,
  actor: string,
  kind: "comment" | "changes_requested" | "review_commented",
  meta: BaseMeta,
  opts: { forceNewPing: boolean },
  deps: NotificationDependencies = productionNotifications,
): Promise<PrRecord> {
  if (!behaviour.authorDms) return pr;
  if (isMuted(behaviour, authorLogin)) return pr;
  if (authorLogin.toLowerCase() === actor.toLowerCase()) return pr;

  const workspaces = behaviour.destinations.map((destination) => destination.workspace);
  const resolved = await deps.users.resolve(config, githubToken, authorLogin, workspaces);
  if (!resolved) return pr;
  const ws = config.slackWorkspaces[resolved.workspace];
  if (!ws) return pr;

  const { text, blocks } = buildAuthorDmBlocks({
    actor,
    kind,
    title: meta.title,
    number: meta.number,
    htmlUrl: meta.htmlUrl,
    repo: meta.repo,
  });

  try {
    if (pr.author_dm?.message_ts && !opts.forceNewPing) {
      const dmChannel = await deps.slack.openDm(ws.bot_token, resolved.slackUserId);
      await deps.slack.updateMessage(
        ws.bot_token,
        dmChannel,
        pr.author_dm.message_ts,
        text,
        blocks,
      );
      log.info("author_dm_updated", { github_user: authorLogin, decision: "silent_update" });
      return pr;
    }

    const dmChannel = await deps.slack.openDm(ws.bot_token, resolved.slackUserId);
    const ts = await postMessageOnce(
      deps,
      config,
      meta.deliveryId,
      `author:${authorLogin.toLowerCase()}:${kind}`,
      ws.bot_token,
      dmChannel,
      text,
      blocks,
    );
    const next: PrRecord = {
      ...pr,
      author_dm: {
        workspace: resolved.workspace,
        slack_user_id: resolved.slackUserId,
        message_ts: ts,
      },
    };
    await deps.store.putPr(config.tableName, next);
    log.info("author_dm_sent", {
      github_user: authorLogin,
      kind,
      decision: opts.forceNewPing ? "fresh_ping" : "first_ping",
    });
    return next;
  } catch (err) {
    log.error("author_dm_failed", {
      github_user: authorLogin,
      error_class: (err as Error).name,
    });
    throw err;
  }
}

export async function sendMentionDms(
  config: AppConfig,
  behaviour: ResolvedBehaviour,
  githubToken: string,
  mentions: string[],
  actor: string,
  meta: BaseMeta & { commentUrl: string },
  deps: NotificationDependencies = productionNotifications,
): Promise<void> {
  if (!behaviour.mentionDms) return;
  const workspaces = behaviour.destinations.map((destination) => destination.workspace);

  for (const login of mentions) {
    if (isMuted(behaviour, login)) continue;
    if (login.toLowerCase() === actor.toLowerCase()) continue;

    const resolved = await deps.users.resolve(config, githubToken, login, workspaces);
    if (!resolved) continue;
    const ws = config.slackWorkspaces[resolved.workspace];
    if (!ws) continue;

    const { text, blocks } = buildMentionDmBlocks({
      actor,
      title: meta.title,
      number: meta.number,
      htmlUrl: meta.htmlUrl,
      commentUrl: meta.commentUrl,
      repo: meta.repo,
    });
    try {
      const dmChannel = await deps.slack.openDm(ws.bot_token, resolved.slackUserId);
      await postMessageOnce(
        deps,
        config,
        meta.deliveryId,
        `mention:${login.toLowerCase()}`,
        ws.bot_token,
        dmChannel,
        text,
        blocks,
      );
      log.info("mention_dm_sent", { github_user: login });
    } catch (err) {
      log.error("mention_dm_failed", {
        github_user: login,
        error_class: (err as Error).name,
      });
      throw err;
    }
  }
}

export function upsertReviewer(
  reviewers: ReviewerState[],
  github: string,
  status: ReviewerState["status"],
  opts?: { round?: number; bumpRound?: boolean },
): ReviewerState[] {
  const next = [...reviewers];
  const idx = next.findIndex(
    (reviewer) => reviewer.github.toLowerCase() === github.toLowerCase(),
  );
  if (idx < 0) {
    next.push({ github, status, round: opts?.round ?? 1 });
    return next;
  }
  const current = next[idx];
  const round = opts?.round ?? (opts?.bumpRound ? current.round + 1 : current.round);
  next[idx] = { github: current.github, status, round };
  return next;
}

export function removeReviewer(reviewers: ReviewerState[], github: string): ReviewerState[] {
  return reviewers.filter(
    (reviewer) => reviewer.github.toLowerCase() !== github.toLowerCase(),
  );
}
