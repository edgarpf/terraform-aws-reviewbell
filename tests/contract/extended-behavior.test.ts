import { describe, expect, it, vi } from "vitest";
import {
  checkSuiteEvent,
  issueCommentEvent,
  prEvent,
  reviewCommentEvent,
  reviewEvent,
} from "../helpers/github-fixtures";
import { ReviewBellHarness, testConfig } from "../helpers/harness";

const route = { workspace: "eng", channel: "#reviews", message_ts: "1.000001" };

describe("pull request lifecycle coverage", () => {
  it.each(["synchronize", "assigned", "labeled", "unlabeled", "unassigned"])(
    "ignores the %s action",
    async (action) => {
      const harness = new ReviewBellHarness();
      await harness.send("pull_request", prEvent({ action }), {
        deliveryId: `skip-${action}`,
      });
      expect(harness.pr()).toBeNull();
    },
  );

  it("updates a board after title edits and conversion back to draft", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ routes: [route] });
    await harness.send("pull_request", prEvent({ action: "edited", title: "New title" }), {
      deliveryId: "edit",
    });
    expect(harness.pr()?.title).toBe("New title");
    expect(harness.updates().at(-1)?.text).toContain("New title");

    await harness.send(
      "pull_request",
      prEvent({ action: "converted_to_draft", draft: true }),
      { deliveryId: "draft-again" },
    );
    expect(harness.pr()?.status).toBe("draft");
    expect(harness.updates().at(-1)?.text).toContain("DRAFT");
  });

  it("does not invent state for edits, draft conversion, or closure of unknown PRs", async () => {
    const harness = new ReviewBellHarness();
    for (const action of ["edited", "converted_to_draft", "closed"]) {
      await harness.send("pull_request", prEvent({ action }), {
        deliveryId: `missing-${action}`,
      });
    }
    expect(harness.pr()).toBeNull();
  });

  it("reopens an existing PR in place and recreates a missing board", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ status: "closed", routes: [route] });
    await harness.send("pull_request", prEvent({ action: "reopened" }), {
      deliveryId: "reopen-existing",
    });
    expect(harness.pr()?.status).toBe("open");
    expect(harness.updates()).toHaveLength(1);

    const noBoard = new ReviewBellHarness();
    noBoard.seedPr({ status: "closed", routes: [] });
    await noBoard.send("pull_request", prEvent({ action: "reopened" }), {
      deliveryId: "reopen-board",
    });
    expect(noBoard.posts()).toHaveLength(1);

    const noState = new ReviewBellHarness();
    await noState.send("pull_request", prEvent({ action: "reopened" }), {
      deliveryId: "reopen-missing",
    });
    expect(noState.pr()?.status).toBe("open");
  });

  it("removes a reviewer then treats re-add as a new round", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("pull_request", prEvent({ reviewers: ["bob"] }), {
      deliveryId: "remove-open",
    });
    await harness.send(
      "pull_request",
      prEvent({ action: "review_request_removed", requestedReviewer: "bob" }),
      { deliveryId: "remove" },
    );
    expect(harness.pr()?.reviewers).toEqual([]);
    await harness.send(
      "pull_request",
      prEvent({ action: "review_requested", requestedReviewer: "bob" }),
      { deliveryId: "readd" },
    );
    expect(harness.pr()?.reviewers[0]).toMatchObject({ round: 2, status: "pending" });
    expect(harness.pr()?.dm_routes[0].notified_round).toBe(2);
  });

  it("ignores team-only review requests and malformed removals", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ routes: [route] });
    await harness.send(
      "pull_request",
      prEvent({ action: "review_requested", requestedTeam: "platform" }),
      { deliveryId: "team-request" },
    );
    await harness.send("pull_request", prEvent({ action: "review_request_removed" }), {
      deliveryId: "bad-remove",
    });
    expect(harness.pr()?.reviewers).toEqual([]);
    expect(harness.posts()).toEqual([]);
  });
});

describe("reviews and comments", () => {
  it("resets a dismissed review and lets the next explicit request advance its round", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [route],
      reviewers: [{ github: "bob", status: "approved", round: 1 }],
    });
    await harness.send(
      "pull_request_review",
      reviewEvent({ action: "dismissed", state: "dismissed", reviewer: "bob" }),
      { deliveryId: "dismiss" },
    );
    expect(harness.pr()?.reviewers[0].status).toBe("pending");
    await harness.send(
      "pull_request",
      prEvent({ action: "review_requested", requestedReviewer: "bob" }),
      { deliveryId: "dismiss-rerequest" },
    );
    expect(harness.pr()?.reviewers[0].round).toBe(2);
  });

  it("handles a review comment, review-body mentions, and draft gating", async () => {
    const harness = new ReviewBellHarness();
    await harness.send(
      "pull_request_review",
      reviewEvent({ state: "commented", reviewer: "bob", body: "cc @dana" }),
      { deliveryId: "review-body" },
    );
    expect(harness.posts().map((call) => call.channel)).toEqual([
      "D_U_ALICE",
      "D_U_DANA",
    ]);

    const reviewComment = new ReviewBellHarness();
    await reviewComment.send(
      "pull_request_review_comment",
      reviewCommentEvent({ actor: "bob", body: "please ask @carol" }),
      { deliveryId: "review-comment" },
    );
    expect(reviewComment.posts().map((call) => call.channel)).toEqual([
      "D_U_ALICE",
      "D_U_CAROL",
    ]);

    const draft = new ReviewBellHarness();
    await draft.send(
      "pull_request_review_comment",
      reviewCommentEvent({ draft: true, actor: "bob", body: "cc @dana" }),
      { deliveryId: "draft-review-comment" },
    );
    expect(draft.posts().map((call) => call.channel)).toEqual(["D_U_DANA"]);
  });

  it("drops unsupported review/comment lifecycles and malformed payloads", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("pull_request_review", reviewEvent({ action: "edited" }), {
      deliveryId: "review-edited",
    });
    await harness.send(
      "pull_request_review_comment",
      reviewCommentEvent({ action: "deleted" }),
      { deliveryId: "review-comment-deleted" },
    );
    await harness.send("issue_comment", issueCommentEvent({ action: "edited" }), {
      deliveryId: "issue-comment-edited",
    });
    await harness.send(
      "issue_comment",
      issueCommentEvent({ isPullRequest: false }),
      { deliveryId: "plain-issue" },
    );
    expect(harness.posts()).toEqual([]);
  });
});

describe("notification guarantees", () => {
  it("blocks muted users in reviewer, author, and mention roles", async () => {
    const reviewer = new ReviewBellHarness(testConfig({ mutedUsers: ["bob"] }));
    await reviewer.send("pull_request", prEvent({ reviewers: ["bob"] }), {
      deliveryId: "muted-reviewer",
    });
    expect(reviewer.posts().map((call) => call.channel)).toEqual(["C_REVIEWS"]);

    const author = new ReviewBellHarness(testConfig({ mutedUsers: ["alice"] }));
    await author.send("issue_comment", issueCommentEvent({ actor: "bob" }), {
      deliveryId: "muted-author",
    });
    expect(author.posts()).toEqual([]);

    const mention = new ReviewBellHarness(testConfig({ mutedUsers: ["dana"] }));
    await mention.send(
      "issue_comment",
      issueCommentEvent({ actor: "bob", body: "cc @dana" }),
      { deliveryId: "muted-mention" },
    );
    expect(mention.posts().map((call) => call.channel)).toEqual(["D_U_ALICE"]);
  });

  it("ignores mentions in code, quotes, teams, duplicates, and the actor", async () => {
    const harness = new ReviewBellHarness();
    await harness.send(
      "issue_comment",
      issueCommentEvent({
        actor: "bob",
        author: "bob",
        body: [
          "@dana please look",
          "again @DANA and self @bob",
          "`@carol`",
          "> @alice quoted",
          "```\n@eve\n```",
          "@acme/platform",
        ].join("\n"),
      }),
      { deliveryId: "mention-filter" },
    );
    expect(harness.posts().map((call) => call.channel)).toEqual(["D_U_DANA"]);
  });

  it("uses real Slack mentions on the channel when personal DMs are disabled", async () => {
    const harness = new ReviewBellHarness(testConfig({ personalDms: false }));
    await harness.send("pull_request", prEvent({ reviewers: ["bob"] }), {
      deliveryId: "channel-mention",
    });
    expect(JSON.stringify(harness.posts()[0].blocks)).toContain("<@U_BOB>");
    expect(harness.posts()).toHaveLength(1);
  });

  it("honors all three DM toggles and the bot filter", async () => {
    const quiet = new ReviewBellHarness(
      testConfig({ personalDms: false, authorDms: false, mentionDms: false }),
    );
    await quiet.send("pull_request", prEvent({ reviewers: ["bob"] }), {
      deliveryId: "toggle-reviewer",
    });
    await quiet.send(
      "issue_comment",
      issueCommentEvent({ actor: "carol", body: "cc @dana" }),
      { deliveryId: "toggle-comments" },
    );
    expect(quiet.posts()).toHaveLength(1);

    const bots = new ReviewBellHarness();
    await bots.send(
      "pull_request",
      prEvent({ sender: "renovate[bot]", senderType: "Bot" }),
      { deliveryId: "bot" },
    );
    expect(bots.pr()).toBeNull();

    const allowed = new ReviewBellHarness(testConfig({ ignoreBots: false }));
    await allowed.send(
      "pull_request",
      prEvent({ sender: "renovate[bot]", senderType: "Bot" }),
      { deliveryId: "bot-allowed" },
    );
    expect(allowed.pr()).not.toBeNull();
  });

  it("supports multiple workspaces and channels while skipping unknown workspaces", async () => {
    const config = testConfig({
      slackWorkspaces: {
        eng: { bot_token: "eng-token" },
        ops: { bot_token: "ops-token" },
      },
      mappings: [
        {
          repo: "acme/widget",
          destinations: [
            { workspace: "eng", channels: ["#reviews", "C_DIRECT"] },
            { workspace: "ops", channels: ["#ops"] },
            { workspace: "missing", channels: ["#ignored"] },
          ],
        },
      ],
    });
    const harness = new ReviewBellHarness(config);
    await harness.send("pull_request", prEvent(), { deliveryId: "fanout" });
    expect(harness.pr()?.routes).toHaveLength(3);
    expect(harness.posts().map((call) => call.channel)).toEqual([
      "C_REVIEWS",
      "C_DIRECT",
      "C_OPS",
    ]);
  });

  it("silently skips unresolved users", async () => {
    const harness = new ReviewBellHarness();
    harness.dependencies.notifications.users.resolve = async () => null;
    await harness.send("pull_request", prEvent({ reviewers: ["unknown"] }), {
      deliveryId: "unresolved-reviewer",
    });
    await harness.send(
      "issue_comment",
      issueCommentEvent({ actor: "bob", body: "cc @unknown" }),
      { deliveryId: "unresolved-comment" },
    );
    expect(harness.posts().map((call) => call.channel)).toEqual(["C_REVIEWS"]);
  });

  it("renews PR state TTL even when activity deliberately sends no notification", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ expires_at: 1 });
    await harness.send(
      "issue_comment",
      issueCommentEvent({ actor: "alice", author: "alice" }),
      { deliveryId: "ttl-self-reply" },
    );
    expect(harness.pr()?.expires_at).toBe(9_999_999);
    expect(harness.posts()).toEqual([]);
  });
});

describe("CI and retry behavior", () => {
  it("ignores CI when disabled, when no board exists, or when the event cannot map a PR", async () => {
    const disabled = new ReviewBellHarness(testConfig({ ciNotifications: false }));
    disabled.seedPr({ routes: [route] });
    await disabled.send("check_suite", checkSuiteEvent(), { deliveryId: "ci-disabled" });
    expect(disabled.pr()?.ci_status).toBeNull();

    const noBoard = new ReviewBellHarness();
    noBoard.seedPr();
    await noBoard.send("check_suite", checkSuiteEvent(), { deliveryId: "ci-no-board" });
    expect(noBoard.pr()?.ci_status).toBeNull();

    const status = new ReviewBellHarness();
    status.seedPr({ routes: [route] });
    await status.send("status", { ...checkSuiteEvent(), sha: "abc" }, { deliveryId: "status" });
    expect(status.pr()?.ci_status).toBeNull();
  });

  it("aggregates pending, pass-like, and failure-like check suite conclusions", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ routes: [route] });
    await harness.send(
      "check_suite",
      checkSuiteEvent({ action: "requested", app: "build" }),
      { deliveryId: "ci-pending" },
    );
    expect(harness.pr()?.ci_status).toBe("pending");
    for (const [index, conclusion] of ["neutral", "skipped", "success"].entries()) {
      await harness.send(
        "check_suite",
        checkSuiteEvent({ conclusion, app: `pass-${index}` }),
        { deliveryId: `ci-pass-${index}` },
      );
    }
    expect(harness.pr()?.ci_status).toBe("pending");
    await harness.send(
      "check_suite",
      checkSuiteEvent({ conclusion: "timed_out", app: "build" }),
      { deliveryId: "ci-fail" },
    );
    expect(harness.pr()?.ci_status).toBe("fail");
  });

  it("records successful fan-out effects so retry does not repeat them", async () => {
    const config = testConfig({
      mappings: [
        {
          repo: "acme/widget",
          destinations: [{ workspace: "eng", channels: ["#one", "#two"] }],
        },
      ],
    });
    const harness = new ReviewBellHarness(config);
    harness.slack.failPostAt.add(2);
    const first = await harness.send("pull_request", prEvent(), {
      deliveryId: "partial",
    });
    expect(first.statusCode).toBe(500);
    expect(harness.posts().map((call) => call.channel)).toEqual(["C_ONE"]);

    const retry = await harness.send("pull_request", prEvent(), {
      deliveryId: "partial",
    });
    expect(retry.statusCode).toBe(200);
    expect(harness.posts().map((call) => call.channel)).toEqual(["C_ONE", "C_TWO"]);
    expect(harness.pr()?.routes).toHaveLength(2);
  });

  it("returns a retryable response for optimistic state conflicts", async () => {
    const harness = new ReviewBellHarness();
    const original = harness.store.putPr.bind(harness.store);
    harness.store.putPr = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("conflict"), {
        name: "ConditionalCheckFailedException",
      }))
      .mockImplementation(original);
    const first = await harness.send("pull_request", prEvent(), {
      deliveryId: "conflict",
    });
    expect(first.statusCode).toBe(500);
    const second = await harness.send("pull_request", prEvent(), {
      deliveryId: "conflict",
    });
    expect(second.statusCode).toBe(200);
  });

  it("does not deduplicate distinct concurrent events and permits conflict retry", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [route],
      reviewers: [
        { github: "bob", status: "pending", round: 1 },
        { github: "carol", status: "pending", round: 1 },
      ],
    });
    const events = await Promise.all([
      harness.send("pull_request_review", reviewEvent({ reviewer: "bob", state: "approved" }), {
        deliveryId: "concurrent-bob",
      }),
      harness.send(
        "pull_request_review",
        reviewEvent({ reviewer: "carol", state: "changes_requested" }),
        { deliveryId: "concurrent-carol" },
      ),
    ]);
    const failed = events.findIndex((response) => response.statusCode === 500);
    if (failed >= 0) {
      const retry = await harness.send(
        "pull_request_review",
        failed === 0
          ? reviewEvent({ reviewer: "bob", state: "approved" })
          : reviewEvent({ reviewer: "carol", state: "changes_requested" }),
        { deliveryId: failed === 0 ? "concurrent-bob" : "concurrent-carol" },
      );
      expect(retry.statusCode).toBe(200);
    }
    expect(harness.store.deliveries.get("concurrent-bob")?.state).toBe("completed");
    expect(harness.store.deliveries.get("concurrent-carol")?.state).toBe("completed");
  });
});
