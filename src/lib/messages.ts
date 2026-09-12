import type { KnownBlock } from "@slack/types";
import { CiStatus, Emojis, PrStatus, ReviewerState } from "./types";

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function statusBadge(
  status: PrStatus,
  reviewers: ReviewerState[],
  ci: CiStatus,
  emojis: Emojis,
  personalDms: boolean,
): string {
  if (status === "merged") return `:${emojis.merged}: MERGED`;
  if (status === "closed") return `:${emojis.closed}: CLOSED`;
  if (status === "draft") return `:${emojis.opened}: DRAFT`;

  const observed = reviewers.filter((r) => r.status !== "commented");
  if (observed.length > 0 && observed.every((r) => r.status === "approved")) {
    return `:${emojis.approved}: APPROVED`;
  }
  if (observed.some((r) => r.status === "changes_requested")) {
    return `:${emojis.changes_requested}: CHANGES REQUESTED`;
  }
  void personalDms;
  let badge = `:${emojis.opened}: OPEN`;
  if (ci === "pass") badge += `  :${emojis.ci_pass}:`;
  if (ci === "fail") badge += `  :${emojis.ci_fail}:`;
  return badge;
}

function reviewerLine(
  r: ReviewerState,
  emojis: Emojis,
  personalDms: boolean,
  slackMentionId?: string,
): string {
  let icon = "○";
  if (r.status === "approved") icon = `:${emojis.approved}:`;
  else if (r.status === "changes_requested") icon = `:${emojis.changes_requested}:`;
  else if (r.status === "pending") icon = "○";

  // When personal_dms is false, @mention in channel as the alert mechanism
  const name =
    !personalDms && slackMentionId ? `<@${slackMentionId}>` : `@${r.github}`;
  return `${icon}  ${name}`;
}

export function buildChannelBlocks(opts: {
  title: string;
  number: number;
  htmlUrl: string;
  repo: string;
  author: string;
  status: PrStatus;
  reviewers: ReviewerState[];
  ci: CiStatus;
  emojis: Emojis;
  personalDms: boolean;
  slackMentions?: Record<string, string>;
}): { text: string; blocks: KnownBlock[] } {
  const badge = statusBadge(
    opts.status,
    opts.reviewers,
    opts.ci,
    opts.emojis,
    opts.personalDms,
  );
  const titleLine = `<${opts.htmlUrl}|${escapeMrkdwn(opts.title)} #${opts.number}>`;
  const reviewerLines =
    opts.reviewers.length === 0
      ? "_no reviewers assigned_"
      : opts.reviewers
          .map((r) =>
            reviewerLine(r, opts.emojis, opts.personalDms, opts.slackMentions?.[r.github]),
          )
          .join("\n");

  const text = `${badge}  ${opts.title} #${opts.number}`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${badge}*\n${titleLine}\n${opts.repo}  ·  by @${opts.author}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: reviewerLines },
    },
  ];
  return { text, blocks };
}

export function buildReviewerDmBlocks(opts: {
  title: string;
  number: number;
  htmlUrl: string;
  repo: string;
  author: string;
  reRequest?: boolean;
}): { text: string; blocks: KnownBlock[] } {
  const headline = opts.reRequest
    ? "🔁 You've been re-requested to review a PR"
    : "👀 You've been asked to review a PR";
  const text = `${headline}: ${opts.title} #${opts.number}`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${headline}*\n\n<${opts.htmlUrl}|${escapeMrkdwn(opts.title)} #${opts.number}>\n${opts.repo}  ·  by @${opts.author}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR →" },
          url: opts.htmlUrl,
        },
      ],
    },
  ];
  return { text, blocks };
}

export function buildAuthorDmBlocks(opts: {
  actor: string;
  kind: "comment" | "changes_requested" | "review_commented";
  title: string;
  number: number;
  htmlUrl: string;
  repo: string;
}): { text: string; blocks: KnownBlock[] } {
  const headline =
    opts.kind === "changes_requested"
      ? `🔴 @${opts.actor} requested changes on your PR`
      : `💬 @${opts.actor} commented on your PR`;
  const text = `${headline}: ${opts.title} #${opts.number}`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${headline}*\n\n<${opts.htmlUrl}|${escapeMrkdwn(opts.title)} #${opts.number}>\n${opts.repo}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR →" },
          url: opts.htmlUrl,
        },
      ],
    },
  ];
  return { text, blocks };
}

export function buildMentionDmBlocks(opts: {
  actor: string;
  title: string;
  number: number;
  htmlUrl: string;
  commentUrl: string;
  repo: string;
}): { text: string; blocks: KnownBlock[] } {
  const headline = `💬 @${opts.actor} mentioned you on a PR`;
  const text = `${headline}: ${opts.title} #${opts.number}`;
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${headline}*\n\n<${opts.htmlUrl}|${escapeMrkdwn(opts.title)} #${opts.number}>\n${opts.repo}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View comment →" },
          url: opts.commentUrl,
        },
      ],
    },
  ];
  return { text, blocks };
}
