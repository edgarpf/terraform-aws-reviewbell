import { describe, expect, it, vi } from "vitest";
import { resolveMapping } from "../../src/lib/config";
import {
  reactMerged,
  refreshChannelMessages,
  sendMentionDms,
  sendReviewerDm,
  upsertAuthorDm,
  upsertReviewer,
} from "../../src/lib/notify";
import { ReviewBellHarness, testConfig } from "../helpers/harness";

const meta = {
  title: "PR",
  number: 42,
  htmlUrl: "https://example/pr/42",
  repo: "acme/widget",
  author: "alice",
  deliveryId: "delivery",
};

describe("notification failure and skip paths", () => {
  it("propagates channel update errors but tolerates reaction failures", async () => {
    const harness = new ReviewBellHarness();
    const behavior = resolveMapping(harness.config, "acme/widget")!;
    const pr = harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1" }],
    });
    harness.slack.updateMessage = vi.fn().mockRejectedValue(new Error("update failed"));
    await expect(
      refreshChannelMessages(
        harness.config,
        behavior,
        "token",
        pr,
        harness.dependencies.notifications,
      ),
    ).rejects.toThrow("update failed");

    harness.slack.resolveChannelId = vi.fn().mockRejectedValue(new Error("missing channel"));
    await expect(
      reactMerged(harness.config, behavior, pr, harness.dependencies.notifications),
    ).resolves.toBeUndefined();
  });

  it("propagates reviewer, author, and mention post failures", async () => {
    const cases = [
      async (harness: ReviewBellHarness) => {
        const behavior = resolveMapping(harness.config, "acme/widget")!;
        return sendReviewerDm(
          harness.config,
          behavior,
          "token",
          harness.seedPr(),
          "bob",
          meta,
          { reRequest: false, round: 1 },
          harness.dependencies.notifications,
        );
      },
      async (harness: ReviewBellHarness) => {
        const behavior = resolveMapping(harness.config, "acme/widget")!;
        return upsertAuthorDm(
          harness.config,
          behavior,
          "token",
          harness.seedPr(),
          "alice",
          "bob",
          "comment",
          meta,
          { forceNewPing: false },
          harness.dependencies.notifications,
        );
      },
      async (harness: ReviewBellHarness) => {
        const behavior = resolveMapping(harness.config, "acme/widget")!;
        return sendMentionDms(
          harness.config,
          behavior,
          "token",
          ["dana"],
          "bob",
          { ...meta, commentUrl: "https://example/comment" },
          harness.dependencies.notifications,
        );
      },
    ];

    for (const run of cases) {
      const harness = new ReviewBellHarness();
      harness.slack.failNextPost = true;
      await expect(run(harness)).rejects.toThrow("slack unavailable");
    }
  });

  it("covers idempotent and unavailable-workspace skip decisions", async () => {
    const harness = new ReviewBellHarness();
    const behavior = resolveMapping(harness.config, "acme/widget")!;
    const notified = harness.seedPr({
      dm_routes: [
        {
          workspace: "eng",
          slack_user_id: "U_BOB",
          message_ts: "1",
          role: "reviewer",
          github: "bob",
          notified_round: 2,
        },
      ],
    });
    const deduped = await sendReviewerDm(
      harness.config,
      behavior,
      "token",
      notified,
      "bob",
      meta,
      { reRequest: true, round: 2 },
      harness.dependencies.notifications,
    );
    expect(deduped).toBe(notified);

    const noWorkspace = testConfig({ slackWorkspaces: {} });
    const noWorkspaceBehavior = resolveMapping(noWorkspace, "acme/widget")!;
    expect(
      await sendReviewerDm(
        noWorkspace,
        noWorkspaceBehavior,
        "token",
        harness.seedPr(),
        "bob",
        meta,
        { reRequest: false, round: 1 },
        harness.dependencies.notifications,
      ),
    ).toBeDefined();
  });

  it("updates reviewer entries case-insensitively and can bump rounds", () => {
    expect(upsertReviewer([], "Bob", "pending")).toEqual([
      { github: "Bob", status: "pending", round: 1 },
    ]);
    expect(
      upsertReviewer([{ github: "Bob", status: "approved", round: 3 }], "bob", "pending", {
        bumpRound: true,
      }),
    ).toEqual([{ github: "Bob", status: "pending", round: 4 }]);
  });
});
