import { AppConfig, PrRecord, ResolvedBehaviour } from "./lib/types";
import { resolveMapping } from "./lib/config";
import { emptyPrRecord } from "./lib/store";
import { extractMentions } from "./lib/mentions";
import { log } from "./lib/logger";
import {
  ensureChannelMessages,
  reactMerged,
  refreshChannelMessages,
  removeReviewer,
  sendMentionDms,
  sendReviewerDm,
  upsertAuthorDm,
  upsertReviewer,
} from "./lib/notify";
import type { ProcessDependencies, StorePort } from "./lib/dependencies";
import { productionProcessDependencies } from "./lib/runtime";

export interface EventContext {
  config: AppConfig;
  githubToken: string;
  deliveryId: string;
  eventName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  dependencies?: ProcessDependencies;
}

function fullRepo(payload: { repository?: { full_name?: string } }): string {
  return payload.repository?.full_name ?? "";
}

function behaviourOrNull(config: AppConfig, repo: string): ResolvedBehaviour | null {
  return resolveMapping(config, repo);
}

async function loadOrInitPr(
  store: StorePort,
  config: AppConfig,
  repo: string,
  number: number,
  seed: Partial<PrRecord>,
): Promise<PrRecord> {
  const existing = await store.getPr(config.tableName, repo, number);
  if (existing) {
    await store.putPr(config.tableName, existing);
    return existing;
  }
  const { record } = await store.createPrIfAbsent(
    config.tableName,
    emptyPrRecord(repo, number, seed),
  );
  return record;
}

export async function processEvent(
  ctx: EventContext,
  dependencies: ProcessDependencies = productionProcessDependencies,
): Promise<void> {
  const runtimeCtx = { ...ctx, dependencies };
  const { config, eventName, payload } = runtimeCtx;
  const repo = fullRepo(payload);
  if (!repo) {
    log.info("skip_no_repo", { event: eventName, decision: "drop" });
    return;
  }

  const behaviour = behaviourOrNull(config, repo);
  if (!behaviour) {
    log.info("skip_no_mapping", { event: eventName, repo, decision: "drop" });
    return;
  }

  // Bot filter
  const senderType = payload.sender?.type;
  if (
    eventName !== "check_suite" &&
    eventName !== "status" &&
    behaviour.ignoreBots &&
    (senderType === "Bot" || payload.sender?.login?.endsWith("[bot]"))
  ) {
    log.info("skip_bot", {
      event: eventName,
      repo,
      github_user: payload.sender?.login,
      decision: "drop",
    });
    return;
  }

  switch (eventName) {
    case "pull_request":
      await handlePullRequest(runtimeCtx, behaviour, repo);
      break;
    case "pull_request_review":
      await handlePullRequestReview(runtimeCtx, behaviour, repo);
      break;
    case "pull_request_review_comment":
      await handleReviewComment(runtimeCtx, behaviour, repo);
      break;
    case "issue_comment":
      await handleIssueComment(runtimeCtx, behaviour, repo);
      break;
    case "check_suite":
    case "status":
      await handleCi(runtimeCtx, behaviour, repo);
      break;
    default:
      log.info("skip_unhandled_event", { event: eventName, repo, decision: "drop" });
  }
}

async function handlePullRequest(
  ctx: EventContext,
  behaviour: ResolvedBehaviour,
  repo: string,
): Promise<void> {
  const { config, githubToken, payload, deliveryId } = ctx;
  const dependencies = ctx.dependencies!;
  const { store } = dependencies;
  const action = payload.action as string;
  const pr = payload.pull_request;
  if (!pr) return;

  const number = pr.number as number;
  const title = pr.title as string;
  const htmlUrl = pr.html_url as string;
  const author = pr.user?.login as string;
  const draft = Boolean(pr.draft);
  const meta = { title, number, htmlUrl, repo, author };

  log.info("pull_request", { event: "pull_request", action, repo, pr: number });

  if (action === "synchronize" || action === "assigned" || action === "labeled" || action === "unlabeled" || action === "unassigned") {
    const existing = await store.getPr(config.tableName, repo, number);
    if (existing) await store.putPr(config.tableName, existing);
    log.info("skip_action", { action, decision: "drop" });
    return;
  }

  if (action === "opened") {
    if (draft) {
      // Ambient board + DMs wait for ready. Deliberate review_requested events pierce later.
      const requested = (pr.requested_reviewers ?? []) as Array<{ login: string }>;
      await loadOrInitPr(store, config, repo, number, {
        status: "draft",
        title,
        html_url: htmlUrl,
        author,
        reviewers: requested.map((r) => ({ github: r.login, status: "pending" as const, round: 1 })),
      });
      log.info("draft_opened_deferred", { repo, pr: number, decision: "wait_for_ready" });
      return;
    }

    const requested = (pr.requested_reviewers ?? []) as Array<{ login: string }>;
    const reviewers = requested.map((r) => ({
      github: r.login,
      status: "pending" as const,
      round: 1,
    }));

    let { record } = await store.createPrIfAbsent(
      config.tableName,
      emptyPrRecord(repo, number, {
        status: "open",
        title,
        html_url: htmlUrl,
        author,
        reviewers,
      }),
    );

    record = await ensureChannelMessages(
      config,
      behaviour,
      githubToken,
      record,
      { ...meta, deliveryId },
      dependencies.notifications,
    );
    for (const r of requested) {
      record = await sendReviewerDm(
        config,
        behaviour,
        githubToken,
        record,
        r.login,
        { ...meta, deliveryId },
        { reRequest: false, round: 1 },
        dependencies.notifications,
      );
    }
    return;
  }

  if (action === "ready_for_review") {
    const requested = (pr.requested_reviewers ?? []) as Array<{ login: string }>;
    let record = await loadOrInitPr(store, config, repo, number, {
      status: "open",
      title,
      html_url: htmlUrl,
      author,
      reviewers: requested.map((r) => ({ github: r.login, status: "pending" as const, round: 1 })),
    });
    record = {
      ...record,
      status: "open",
      title,
      html_url: htmlUrl,
      author,
      reviewers:
        record.reviewers.length > 0
          ? record.reviewers
          : requested.map((r) => ({ github: r.login, status: "pending" as const, round: 1 })),
    };
    record = await ensureChannelMessages(
      config,
      behaviour,
      githubToken,
      record,
      { ...meta, deliveryId },
      dependencies.notifications,
    );
    for (const r of requested) {
      const round = record.reviewers.find((x) => x.github.toLowerCase() === r.login.toLowerCase())?.round ?? 1;
      record = await sendReviewerDm(
        config,
        behaviour,
        githubToken,
        record,
        r.login,
        { ...meta, deliveryId },
        { reRequest: false, round },
        dependencies.notifications,
      );
    }
    return;
  }

  if (action === "converted_to_draft") {
    const record = await store.getPr(config.tableName, repo, number);
    if (!record) return;
    const next = { ...record, status: "draft" as const, title, html_url: htmlUrl };
    await store.putPr(config.tableName, next);
    if (next.routes.length > 0)
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        next,
        dependencies.notifications,
      );
    return;
  }

  if (action === "edited") {
    const record = await store.getPr(config.tableName, repo, number);
    if (!record) return;
    const next = { ...record, title, html_url: htmlUrl };
    await store.putPr(config.tableName, next);
    if (next.routes.length === 0) return;
    await refreshChannelMessages(
      config,
      behaviour,
      githubToken,
      next,
      dependencies.notifications,
    );
    return;
  }

  if (action === "reopened") {
    const record = await store.getPr(config.tableName, repo, number);
    if (!record) {
      // Treat like open if we lost state
      await handlePullRequest(
        { ...ctx, payload: { ...payload, action: "opened", pull_request: { ...pr, draft: false } } },
        behaviour,
        repo,
      );
      return;
    }
    const next = {
      ...record,
      status: draft ? ("draft" as const) : ("open" as const),
      title,
      html_url: htmlUrl,
    };
    await store.putPr(config.tableName, next);
    if (next.routes.length > 0)
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        next,
        dependencies.notifications,
      );
    else if (!draft)
      await ensureChannelMessages(
        config,
        behaviour,
        githubToken,
        next,
        { ...meta, deliveryId },
        dependencies.notifications,
      );
    return;
  }

  if (action === "closed") {
    const record = await store.getPr(config.tableName, repo, number);
    if (!record) return;
    const merged = Boolean(pr.merged);
    const next = {
      ...record,
      status: merged ? ("merged" as const) : ("closed" as const),
      title,
      html_url: htmlUrl,
    };
    await store.putPr(config.tableName, next);
    if (next.routes.length > 0) {
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        next,
        dependencies.notifications,
      );
      if (merged) await reactMerged(config, behaviour, next, dependencies.notifications);
    }
    return;
  }

  if (action === "review_requested") {
    const requested = payload.requested_reviewer as { login?: string } | undefined;
    const requestedTeam = payload.requested_team as { slug?: string } | undefined;
    if (!requested?.login) {
      // Team-only — no DM; reflect on board when it exists
      log.info("team_review_requested", { repo, pr: number, decision: "defer_to_github" });
      const record = await store.getPr(config.tableName, repo, number);
      if (!draft && record && record.routes.length > 0) {
        // No individual reviewer to add; board unchanged except maybe note
        void requestedTeam;
      }
      if (record) await store.putPr(config.tableName, record);
      return;
    }

    let record = await loadOrInitPr(store, config, repo, number, {
      status: draft ? "draft" : "open",
      title,
      html_url: htmlUrl,
      author,
    });

    const existing = record.reviewers.find(
      (r) => r.github.toLowerCase() === requested.login!.toLowerCase(),
    );
    const existingDm = record.dm_routes.find(
      (route) =>
        route.role === "reviewer" &&
        route.github.toLowerCase() === requested.login!.toLowerCase(),
    );
    const bumpRound = Boolean(existing || existingDm);
    const previousRound = Math.max(existing?.round ?? 0, existingDm?.notified_round ?? 0);
    const round = bumpRound ? previousRound + 1 : 1;
    record = {
      ...record,
      reviewers: upsertReviewer(record.reviewers, requested.login, "pending", {
        round,
      }),
      title,
      html_url: htmlUrl,
      author,
    };
    await store.putPr(config.tableName, record);

    // Channel board only when not draft (or board already exists)
    if (!draft || record.routes.length > 0) {
      if (!draft && record.routes.length === 0) {
        record = await ensureChannelMessages(
          config,
          behaviour,
          githubToken,
          record,
          { ...meta, deliveryId },
          dependencies.notifications,
        );
      } else if (record.routes.length > 0) {
        await refreshChannelMessages(
          config,
          behaviour,
          githubToken,
          record,
          dependencies.notifications,
        );
      }
    }

    await sendReviewerDm(
      config,
      behaviour,
      githubToken,
      record,
      requested.login,
      { ...meta, deliveryId },
      { reRequest: bumpRound, round },
      dependencies.notifications,
    );
    return;
  }

  if (action === "review_request_removed") {
    const removed = payload.requested_reviewer as { login?: string } | undefined;
    if (!removed?.login) return;
    const record = await store.getPr(config.tableName, repo, number);
    if (!record) return;
    const next = {
      ...record,
      reviewers: removeReviewer(record.reviewers, removed.login),
    };
    await store.putPr(config.tableName, next);
    if (next.routes.length > 0)
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        next,
        dependencies.notifications,
      );
    return;
  }
}

async function handlePullRequestReview(
  ctx: EventContext,
  behaviour: ResolvedBehaviour,
  repo: string,
): Promise<void> {
  const { config, githubToken, payload, deliveryId } = ctx;
  const dependencies = ctx.dependencies!;
  const { store } = dependencies;
  const action = payload.action as string;
  if (action !== "submitted" && action !== "dismissed") {
    log.info("skip_review_action", { action, decision: "drop" });
    return;
  }

  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr) return;

  const number = pr.number as number;
  const title = pr.title as string;
  const htmlUrl = pr.html_url as string;
  const author = pr.user?.login as string;
  const draft = Boolean(pr.draft);
  const reviewer = review.user?.login as string;
  const state = (review.state as string)?.toLowerCase(); // approved | changes_requested | commented | dismissed
  const body = review.body as string | undefined;

  let record = await loadOrInitPr(store, config, repo, number, {
    status: draft ? "draft" : "open",
    title,
    html_url: htmlUrl,
    author,
  });

  if (action === "dismissed" || state === "dismissed") {
    record = {
      ...record,
      reviewers: upsertReviewer(record.reviewers, reviewer, "pending"),
    };
    await store.putPr(config.tableName, record);
    if (record.routes.length > 0)
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        record,
        dependencies.notifications,
      );
    return;
  }

  let status: "approved" | "changes_requested" | "commented" | "pending" = "commented";
  if (state === "approved") status = "approved";
  else if (state === "changes_requested") status = "changes_requested";
  else if (state === "commented") status = "commented";

  if (status !== "commented") {
    record = {
      ...record,
      reviewers: upsertReviewer(record.reviewers, reviewer, status),
      title,
      html_url: htmlUrl,
    };
    await store.putPr(config.tableName, record);
    if (record.routes.length > 0)
      await refreshChannelMessages(
        config,
        behaviour,
        githubToken,
        record,
        dependencies.notifications,
      );
  }

  const meta = { title, number, htmlUrl, repo };

  if (status === "changes_requested") {
    // Deliberate — pierces draft gate; fresh ping
    record = await upsertAuthorDm(
      config,
      behaviour,
      githubToken,
      record,
      author,
      reviewer,
      "changes_requested",
      { ...meta, deliveryId },
      { forceNewPing: true },
      dependencies.notifications,
    );
  } else if (status === "commented" && !draft) {
    record = await upsertAuthorDm(
      config,
      behaviour,
      githubToken,
      record,
      author,
      reviewer,
      "review_commented",
      { ...meta, deliveryId },
      { forceNewPing: false },
      dependencies.notifications,
    );
  }

  // Mentions in review body pierce draft
  const mentions = extractMentions(body, reviewer);
  if (mentions.length > 0) {
    await sendMentionDms(
      config,
      behaviour,
      githubToken,
      mentions,
      reviewer,
      {
        ...meta,
        commentUrl: (review.html_url as string) || htmlUrl,
        deliveryId,
      },
      dependencies.notifications,
    );
  }
}

async function handleReviewComment(
  ctx: EventContext,
  behaviour: ResolvedBehaviour,
  repo: string,
): Promise<void> {
  const { config, githubToken, payload, deliveryId } = ctx;
  const dependencies = ctx.dependencies!;
  const { store } = dependencies;
  const action = payload.action as string;
  if (action !== "created") {
    log.info("skip_comment_lifecycle", { action, decision: "drop" });
    return;
  }

  const comment = payload.comment;
  const pr = payload.pull_request;
  if (!comment || !pr) return;

  const number = pr.number as number;
  const title = pr.title as string;
  const htmlUrl = pr.html_url as string;
  const author = pr.user?.login as string;
  const draft = Boolean(pr.draft);
  const actor = comment.user?.login as string;
  const body = comment.body as string;
  const commentUrl = comment.html_url as string;

  let record = await loadOrInitPr(store, config, repo, number, {
    status: draft ? "draft" : "open",
    title,
    html_url: htmlUrl,
    author,
  });

  const meta = { title, number, htmlUrl, repo };

  // Ambient author DM suppressed on draft
  if (!draft) {
    record = await upsertAuthorDm(
      config,
      behaviour,
      githubToken,
      record,
      author,
      actor,
      "comment",
      { ...meta, deliveryId },
      { forceNewPing: false },
      dependencies.notifications,
    );
  }

  const mentions = extractMentions(body, actor);
  if (mentions.length > 0) {
    await sendMentionDms(
      config,
      behaviour,
      githubToken,
      mentions,
      actor,
      { ...meta, commentUrl, deliveryId },
      dependencies.notifications,
    );
  }
}

async function handleIssueComment(
  ctx: EventContext,
  behaviour: ResolvedBehaviour,
  repo: string,
): Promise<void> {
  const { payload, deliveryId } = ctx;
  const dependencies = ctx.dependencies!;
  const { store } = dependencies;
  // Non-PR issue comments drop
  if (!payload.issue?.pull_request) {
    log.info("skip_non_pr_issue_comment", { decision: "drop" });
    return;
  }

  const action = payload.action as string;
  if (action !== "created") {
    log.info("skip_comment_lifecycle", { action, decision: "drop" });
    return;
  }

  const { config, githubToken } = ctx;
  const issue = payload.issue;
  const comment = payload.comment;
  const number = issue.number as number;
  const title = issue.title as string;
  const htmlUrl = (issue.pull_request?.html_url || issue.html_url) as string;
  const author = issue.user?.login as string;
  const actor = comment.user?.login as string;
  const body = comment.body as string;
  const commentUrl = comment.html_url as string;

  // Draft state: issue payload doesn't include draft; look up stored record or assume open
  let record = await store.getPr(config.tableName, repo, number);
  const draft = record?.status === "draft";

  if (!record) {
    record = await loadOrInitPr(store, config, repo, number, {
      status: "open",
      title,
      html_url: htmlUrl,
      author,
    });
  } else {
    await store.putPr(config.tableName, record);
  }

  const meta = { title, number, htmlUrl, repo };

  if (!draft) {
    record = await upsertAuthorDm(
      config,
      behaviour,
      githubToken,
      record,
      author,
      actor,
      "comment",
      { ...meta, deliveryId },
      { forceNewPing: false },
      dependencies.notifications,
    );
  }

  const mentions = extractMentions(body, actor);
  if (mentions.length > 0) {
    await sendMentionDms(
      config,
      behaviour,
      githubToken,
      mentions,
      actor,
      { ...meta, commentUrl, deliveryId },
      dependencies.notifications,
    );
  }
}

async function handleCi(
  ctx: EventContext,
  behaviour: ResolvedBehaviour,
  repo: string,
): Promise<void> {
  if (!behaviour.ciNotifications) {
    log.info("skip_ci", { decision: "disabled" });
    return;
  }

  const { config, eventName, payload, githubToken } = ctx;
  const dependencies = ctx.dependencies!;
  const { store } = dependencies;
  let number: number | null = null;
  let ci: "pass" | "fail" | "pending" | null = null;
  let suiteKey = "default";

  if (eventName === "check_suite") {
    const suite = payload.check_suite;
    const prs = suite?.pull_requests as Array<{ number: number }> | undefined;
    if (!prs?.length) return;
    number = prs[0].number;
    suiteKey = String(suite.app?.slug ?? suite.app?.id ?? "default");
    if (payload.action === "requested" || payload.action === "rerequested") {
      ci = "pending";
    } else if (payload.action === "completed") {
      const conclusion = suite.conclusion as string;
      if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
        ci = "pass";
      } else if (
        conclusion === "failure" ||
        conclusion === "timed_out" ||
        conclusion === "cancelled" ||
        conclusion === "action_required" ||
        conclusion === "startup_failure" ||
        conclusion === "stale"
      ) {
        ci = "fail";
      } else {
        return;
      }
    } else {
      return;
    }
  } else if (eventName === "status") {
    // Commit status — try to find PR via store by scanning isn't feasible;
    // GitHub status events don't always include PR number. Skip if we can't map.
    const sha = payload.sha as string | undefined;
    void sha;
    // Without PR context, status events are best-effort no-ops unless check_suite is used.
    log.info("skip_status_no_pr", { decision: "drop" });
    return;
  }

  if (number == null || !ci) return;

  const record = await store.getPr(config.tableName, repo, number);
  if (!record || record.routes.length === 0) {
    if (record) await store.putPr(config.tableName, record);
    log.info("ci_noop_no_message", { repo, pr: number, decision: "drop" });
    return;
  }

  const ciSuites = { ...(record.ci_suites ?? {}), [suiteKey]: ci };
  const statuses = Object.values(ciSuites);
  const aggregate: "pass" | "fail" | "pending" = statuses.includes("fail")
    ? "fail"
    : statuses.includes("pending")
      ? "pending"
      : "pass";
  const next = { ...record, ci_status: aggregate, ci_suites: ciSuites };
  await store.putPr(config.tableName, next);
  await refreshChannelMessages(
    config,
    behaviour,
    githubToken,
    next,
    dependencies.notifications,
  );
  log.info("ci_badge_updated", { repo, pr: number, outcome: aggregate });
}
