import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { AppConfig } from "../../src/lib/types";
import { DEFAULT_EMOJIS } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({
  getCachedUser: vi.fn(),
  putCachedUser: vi.fn(),
  lookupByEmail: vi.fn(),
}));

vi.mock("../../src/lib/store", () => ({
  getCachedUser: mocks.getCachedUser,
  putCachedUser: mocks.putCachedUser,
}));
vi.mock("../../src/lib/slack", () => ({ lookupByEmail: mocks.lookupByEmail }));

const server = setupServer(
  http.get("https://api.github.com/users/:login", ({ params }) => {
    if (params.login === "broken") {
      return HttpResponse.json({ message: "upstream failed" }, { status: 500 });
    }
    return HttpResponse.json({
      login: params.login,
      id: 1,
      node_id: "node",
      avatar_url: "https://example/avatar",
      gravatar_id: "",
      url: `https://api.github.com/users/${params.login}`,
      html_url: `https://github.com/${params.login}`,
      followers_url: "https://example/followers",
      following_url: "https://example/following{/other_user}",
      gists_url: "https://example/gists{/gist_id}",
      starred_url: "https://example/starred{/owner}{/repo}",
      subscriptions_url: "https://example/subscriptions",
      organizations_url: "https://example/orgs",
      repos_url: "https://example/repos",
      events_url: "https://example/events{/privacy}",
      received_events_url: "https://example/received_events",
      type: "User",
      site_admin: false,
      name: null,
      company: null,
      blog: "",
      location: null,
      email: params.login === "private" ? null : `${params.login}@example.com`,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: 1,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: "2020-01-01T00:00:00Z",
      updated_at: "2020-01-01T00:00:00Z",
    });
  }),
);

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    tableName: "table",
    githubOrgs: { acme: { webhook_secret: "secret", token: "token" } },
    slackWorkspaces: {
      eng: { bot_token: "eng-token" },
      ops: { bot_token: "ops-token" },
    },
    defaultGithubOrg: "acme",
    githubApiBaseUrl: null,
    mappings: [],
    defaultMapping: null,
    userMap: {},
    mutedUsers: [],
    personalDms: true,
    authorDms: true,
    mentionDms: true,
    ignoreBots: true,
    ciNotifications: true,
    emojis: DEFAULT_EMOJIS,
    ...overrides,
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mocks.getCachedUser.mockReset();
  mocks.putCachedUser.mockReset();
  mocks.lookupByEmail.mockReset();
});
afterAll(() => server.close());

describe("GitHub-to-Slack HTTP adapter", () => {
  it("prefers explicit user mappings without making external calls", async () => {
    const { resolveGithubToSlack } = await import("../../src/lib/github");
    const resolved = await resolveGithubToSlack(
      config({ userMap: { Alice: "U_ALICE" } }),
      "mapped-token",
      "Alice",
      [],
    );
    expect(resolved).toEqual({ slackUserId: "U_ALICE", workspace: "eng" });
    expect(mocks.getCachedUser).not.toHaveBeenCalled();
  });

  it("uses positive and negative DynamoDB cache records", async () => {
    const { resolveGithubToSlack } = await import("../../src/lib/github");
    mocks.getCachedUser.mockResolvedValueOnce({
      slack_user_id: "U_CACHED",
      workspace: "missing",
    });
    expect(
      await resolveGithubToSlack(config(), "cache-token", "cached", ["ops"]),
    ).toEqual({ slackUserId: "U_CACHED", workspace: "ops" });

    mocks.getCachedUser.mockResolvedValueOnce({ slack_user_id: null });
    expect(
      await resolveGithubToSlack(config(), "negative-token", "negative", ["eng"]),
    ).toBeNull();
  });

  it("fetches GitHub email over HTTP, tries workspaces in order, and caches the match", async () => {
    const { resolveGithubToSlack } = await import("../../src/lib/github");
    mocks.getCachedUser.mockResolvedValue(undefined);
    mocks.lookupByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce("U_BOB");
    const resolved = await resolveGithubToSlack(
      config(),
      "http-token",
      "bob",
      ["eng", "ops"],
    );
    expect(resolved).toEqual({ slackUserId: "U_BOB", workspace: "ops" });
    expect(mocks.lookupByEmail).toHaveBeenNthCalledWith(1, "eng-token", "bob@example.com");
    expect(mocks.lookupByEmail).toHaveBeenNthCalledWith(2, "ops-token", "bob@example.com");
    expect(mocks.putCachedUser).toHaveBeenCalledWith("table", "bob", "U_BOB", "ops");
  });

  it("negative-caches private-email, malformed, and failed lookups", async () => {
    const { resolveGithubToSlack } = await import("../../src/lib/github");
    mocks.getCachedUser.mockResolvedValue(undefined);
    for (const login of ["private", "broken"]) {
      expect(
        await resolveGithubToSlack(config(), `${login}-token`, login, ["eng"]),
      ).toBeNull();
      expect(mocks.putCachedUser).toHaveBeenCalledWith("table", login, null);
    }
  });
});
