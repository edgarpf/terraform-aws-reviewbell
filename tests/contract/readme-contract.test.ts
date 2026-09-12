import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  issueCommentEvent,
  prEvent,
  reviewEvent,
  checkSuiteEvent,
} from "../helpers/github-fixtures";
import { ReviewBellHarness, testConfig } from "../helpers/harness";

export const README_SCENARIO_IDS = [
  "RB-001",
  "RB-002",
  "RB-003",
  "RB-004",
  "RB-005",
  "RB-006",
  "RB-007",
  "RB-008",
  "RB-009",
  "RB-010",
  "RB-011",
  "RB-012",
] as const;

describe("README traceability", () => {
  it("has exactly one executable contract for every documented scenario ID", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const documented = [...readme.matchAll(/\| (RB-\d{3}) \|/g)].map((match) => match[1]);
    expect(documented).toEqual([...README_SCENARIO_IDS]);
    expect(new Set(documented).size).toBe(documented.length);
  });
});

describe("README behavior contract", () => {
  it("RB-001 posts an open board and notifies requested reviewers", async () => {
    const harness = new ReviewBellHarness();
    const response = await harness.send(
      "pull_request",
      prEvent({ reviewers: ["bob", "carol"] }),
      { deliveryId: "rb-001" },
    );

    expect(response.statusCode).toBe(200);
    expect(harness.pr()?.status).toBe("open");
    expect(harness.pr()?.routes).toHaveLength(1);
    expect(harness.pr()?.dm_routes.map((route) => route.github)).toEqual(["bob", "carol"]);
    expect(harness.callsByKind("post")).toHaveLength(3);
  });

  it("RB-002 defers the board and ambient notifications for a draft", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("pull_request", prEvent({ draft: true, reviewers: ["bob"] }), {
      deliveryId: "rb-002",
    });

    expect(harness.pr()?.status).toBe("draft");
    expect(harness.pr()?.routes).toEqual([]);
    expect(harness.callsByKind("post")).toEqual([]);
  });

  it("RB-003 creates a board and reviewer DMs when a draft becomes ready", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("pull_request", prEvent({ draft: true, reviewers: ["bob"] }), {
      deliveryId: "rb-003-draft",
    });
    await harness.send(
      "pull_request",
      prEvent({ action: "ready_for_review", reviewers: ["bob"] }),
      { deliveryId: "rb-003-ready" },
    );

    expect(harness.pr()?.status).toBe("open");
    expect(harness.pr()?.routes).toHaveLength(1);
    expect(harness.pr()?.dm_routes[0]).toMatchObject({ github: "bob", notified_round: 1 });
  });

  it("RB-004 resets and re-pings a reviewer on explicit re-request", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("pull_request", prEvent({ reviewers: ["bob"] }), {
      deliveryId: "rb-004-open",
    });
    await harness.send(
      "pull_request",
      prEvent({ action: "review_requested", requestedReviewer: "bob", sender: "alice" }),
      { deliveryId: "rb-004-rerequest" },
    );

    expect(harness.pr()?.reviewers[0]).toMatchObject({ github: "bob", status: "pending", round: 2 });
    expect(harness.pr()?.dm_routes[0].notified_round).toBe(2);
    expect(harness.callsByKind("post").filter((call) => call.channel === "D_U_BOB")).toHaveLength(2);
  });
});

describe("README lifecycle contract", () => {
  it("RB-009 never DMs an author about their own reply", async () => {
    const harness = new ReviewBellHarness();
    await harness.send(
      "issue_comment",
      issueCommentEvent({ actor: "alice", author: "alice", body: "addressed" }),
      { deliveryId: "rb-009" },
    );
    expect(harness.callsByKind("post")).toEqual([]);
  });

  it("RB-010 aggregates CI pass and failure without sending DMs", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1.000001" }],
    });
    await harness.send("check_suite", checkSuiteEvent({ app: "build", conclusion: "success" }), {
      deliveryId: "rb-010-pass",
    });
    expect(harness.pr()?.ci_status).toBe("pass");
    await harness.send("check_suite", checkSuiteEvent({ app: "lint", conclusion: "failure" }), {
      deliveryId: "rb-010-fail",
    });
    expect(harness.pr()?.ci_status).toBe("fail");
    expect(harness.callsByKind("post")).toEqual([]);
  });

  it("RB-011 marks a merged PR and adds the configured reaction", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1.000001" }],
    });
    await harness.send("pull_request", prEvent({ action: "closed", merged: true }), {
      deliveryId: "rb-011",
    });
    expect(harness.pr()?.status).toBe("merged");
    expect(harness.callsByKind("reaction")).toHaveLength(1);
  });

  it("RB-012 marks an unmerged PR closed without a merged reaction", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1.000001" }],
    });
    await harness.send("pull_request", prEvent({ action: "closed", merged: false }), {
      deliveryId: "rb-012",
    });
    expect(harness.pr()?.status).toBe("closed");
    expect(harness.callsByKind("reaction")).toEqual([]);
  });
});

describe("README review and comment contract", () => {
  it("RB-005 updates reviewer approval and emits no DM", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1.000001" }],
      reviewers: [{ github: "bob", status: "pending", round: 1 }],
    });
    await harness.send("pull_request_review", reviewEvent({ state: "approved" }), {
      deliveryId: "rb-005",
    });

    expect(harness.pr()?.reviewers[0].status).toBe("approved");
    expect(harness.callsByKind("update")[0].text).toContain("APPROVED");
    expect(harness.callsByKind("post")).toEqual([]);
  });

  it("RB-006 requests changes and sends the author a fresh DM", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({
      routes: [{ workspace: "eng", channel: "#reviews", message_ts: "1.000001" }],
      reviewers: [{ github: "bob", status: "pending", round: 1 }],
    });
    await harness.send(
      "pull_request_review",
      reviewEvent({ state: "changes_requested", reviewer: "bob" }),
      { deliveryId: "rb-006" },
    );
    expect(harness.pr()?.reviewers[0].status).toBe("changes_requested");
    expect(harness.pr()?.author_dm?.slack_user_id).toBe("U_ALICE");
    expect(harness.callsByKind("post")).toHaveLength(1);
  });

  it("RB-007 posts the first author DM and silently updates later comments", async () => {
    const harness = new ReviewBellHarness();
    await harness.send("issue_comment", issueCommentEvent({ actor: "bob" }), {
      deliveryId: "rb-007-first",
    });
    await harness.send("issue_comment", issueCommentEvent({ actor: "carol" }), {
      deliveryId: "rb-007-second",
    });
    expect(harness.callsByKind("post")).toHaveLength(1);
    expect(harness.callsByKind("update")).toHaveLength(1);

    const draftHarness = new ReviewBellHarness();
    draftHarness.seedPr({ status: "draft" });
    await draftHarness.send("issue_comment", issueCommentEvent({ actor: "bob" }), {
      deliveryId: "rb-007-draft",
    });
    expect(draftHarness.callsByKind("post")).toEqual([]);
  });

  it("RB-008 sends a mention DM on a draft without creating a board", async () => {
    const harness = new ReviewBellHarness();
    harness.seedPr({ status: "draft" });
    await harness.send(
      "issue_comment",
      issueCommentEvent({ actor: "alice", body: "cc @dana" }),
      { deliveryId: "rb-008" },
    );
    expect(harness.callsByKind("post")[0]).toMatchObject({ channel: "D_U_DANA" });
    expect(harness.pr()?.routes).toEqual([]);
  });
});
