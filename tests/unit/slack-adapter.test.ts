import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { KnownBlock } from "@slack/types";

const requests: Array<{ method: string; body: URLSearchParams }> = [];
let channelPage = 0;

const server = setupServer(
  http.post("https://slack.com/api/:method", async ({ params, request }) => {
    const body = new URLSearchParams(await request.text());
    const method = String(params.method);
    requests.push({ method, body });
    if (method === "chat.postMessage") {
      return HttpResponse.json(
        body.get("channel") === "NO_TS" ? { ok: true } : { ok: true, ts: "10.20" },
      );
    }
    if (method === "chat.update") return HttpResponse.json({ ok: true, ts: "10.20" });
    if (method === "conversations.open") {
      if (body.get("users") === "MALFORMED") return HttpResponse.json({ ok: true });
      return HttpResponse.json({ ok: true, channel: { id: "D123" } });
    }
    if (method === "users.lookupByEmail") {
      if (body.get("email") === "missing@example.com") {
        return HttpResponse.json({ ok: false, error: "users_not_found" });
      }
      return HttpResponse.json({ ok: true, user: { id: "U123" } });
    }
    if (method === "reactions.add") {
      if (body.get("name") === "already") {
        return HttpResponse.json({ ok: false, error: "already_reacted" });
      }
      return HttpResponse.json({ ok: true });
    }
    if (method === "conversations.list") {
      channelPage += 1;
      return channelPage === 1
        ? HttpResponse.json({
            ok: true,
            channels: [{ id: "C_OTHER", name: "other" }],
            response_metadata: { next_cursor: "next" },
          })
        : HttpResponse.json({
            ok: true,
            channels: [{ id: "C_REVIEW", name: "reviews" }],
            response_metadata: { next_cursor: "" },
          });
    }
    return HttpResponse.json({ ok: false, error: "unexpected_method" });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  requests.length = 0;
  channelPage = 0;
});
afterAll(() => server.close());

describe("Slack HTTP adapter", () => {
  it("sends deterministic client IDs and validates message timestamps", async () => {
    const { postMessage, updateMessage } = await import("../../src/lib/slack");
    const blocks: KnownBlock[] = [
      { type: "section", text: { type: "mrkdwn", text: "hello" } },
    ];
    expect(await postMessage("token-post", "C1", "hello", blocks, "client-id")).toBe(
      "10.20",
    );
    await updateMessage("token-update", "C1", "10.20", "updated", blocks);
    expect(requests[0].body.get("client_msg_id")).toBe("client-id");
    expect(requests.map((request) => request.method)).toEqual([
      "chat.postMessage",
      "chat.update",
    ]);
  });

  it("opens DMs, resolves email users, and tolerates idempotent reactions", async () => {
    const { addReaction, lookupByEmail, openDm } = await import("../../src/lib/slack");
    expect(await openDm("token-open", "U123")).toBe("D123");
    expect(await lookupByEmail("token-email", "person@example.com")).toBe("U123");
    expect(await lookupByEmail("token-email-missing", "missing@example.com")).toBeNull();
    await expect(addReaction("token-reaction", "C1", "1", ":already:")).resolves.toBeUndefined();
  });

  it("paginates channel lookup, caches hits, passes IDs through, and rejects misses", async () => {
    const { resolveChannelId } = await import("../../src/lib/slack");
    expect(await resolveChannelId("token-channel", "C_DIRECT")).toBe("C_DIRECT");
    expect(await resolveChannelId("token-channel", "#reviews")).toBe("C_REVIEW");
    expect(await resolveChannelId("token-channel", "#REVIEWS")).toBe("C_REVIEW");
    expect(channelPage).toBe(2);

    await expect(resolveChannelId("token-missing-channel", "#missing")).rejects.toThrow(
      "channel_not_found:#missing",
    );
  });

  it("rejects malformed success responses", async () => {
    const { openDm, postMessage } = await import("../../src/lib/slack");
    await expect(openDm("token-malformed", "MALFORMED")).rejects.toThrow(
      "conversations.open returned no channel",
    );
    await expect(postMessage("token-no-ts", "NO_TS", "text", [])).rejects.toThrow(
      "chat.postMessage returned no ts",
    );
  });
});

describe("Slack rate limit retry", () => {
  it("retries bounded rate limits before succeeding", async () => {
    const rateLimit = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_platform_error",
      data: { error: "ratelimited", retry_after: -1 },
    });
    const post = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValue({ ts: "99.1" });
    vi.resetModules();
    vi.doMock("@slack/web-api", () => ({
      WebClient: class {
        chat = { postMessage: post, update: vi.fn() };
        conversations = { open: vi.fn(), list: vi.fn() };
        reactions = { add: vi.fn() };
        users = { lookupByEmail: vi.fn() };
      },
    }));
    const { postMessage } = await import("../../src/lib/slack");
    expect(await postMessage("rate-token", "C1", "text", [])).toBe("99.1");
    expect(post).toHaveBeenCalledTimes(3);
    vi.doUnmock("@slack/web-api");
  });
});
