import { describe, expect, it } from "vitest";
import { isMuted, resolveMapping } from "../../src/lib/config";
import { testConfig } from "../helpers/harness";

describe("routing and behavior configuration", () => {
  it("uses exact, organization wildcard, global wildcard, then fallback precedence", () => {
    const config = testConfig({
      mappings: [
        { repo: "*", destinations: [{ workspace: "eng", channels: ["#global"] }] },
        { repo: "ACME/*", destinations: [{ workspace: "eng", channels: ["#org"] }] },
        {
          repo: "acme/widget",
          destinations: [{ workspace: "eng", channels: ["#exact"] }],
        },
      ],
      defaultMapping: {
        destinations: [{ workspace: "eng", channels: ["#fallback"] }],
      },
    });

    expect(resolveMapping(config, "AcMe/WiDgEt")?.destinations[0].channels).toEqual([
      "#exact",
    ]);
    expect(resolveMapping(config, "acme/other")?.destinations[0].channels).toEqual(["#org"]);
    expect(resolveMapping(config, "elsewhere/repo")?.destinations[0].channels).toEqual([
      "#global",
    ]);

    config.mappings = [];
    expect(resolveMapping(config, "elsewhere/repo")?.destinations[0].channels).toEqual([
      "#fallback",
    ]);
  });

  it("returns null for unmatched repositories and unresolved org references", () => {
    expect(resolveMapping(testConfig({ mappings: [] }), "acme/other")).toBeNull();
    const unresolved = testConfig({
      defaultGithubOrg: null,
      githubOrgs: {
        acme: { webhook_secret: "a", token: "a" },
        other: { webhook_secret: "b", token: "b" },
      },
      mappings: [
        { repo: "*", destinations: [{ workspace: "eng", channels: ["#all"] }] },
      ],
    });
    expect(resolveMapping(unresolved, "acme/widget")).toBeNull();
    unresolved.mappings[0].github_org = "missing";
    expect(resolveMapping(unresolved, "acme/widget")).toBeNull();
  });

  it("applies every per-repository override and merges muted users and emojis", () => {
    const config = testConfig({
      mutedUsers: ["GlobalMute"],
      slackWorkspaces: {
        eng: { bot_token: "x", emojis: { opened: "workspace_open" } },
      },
      mappings: [
        {
          repo: "acme/widget",
          github_org: "acme",
          destinations: [{ workspace: "eng", channels: [] }],
          muted_users: ["RepoMute"],
          personal_dms: false,
          author_dms: false,
          mention_dms: false,
          ignore_bots: false,
          ci_notifications: false,
          emojis: { opened: "rule_open", merged: "shipit" },
        },
      ],
    });
    const behavior = resolveMapping(config, "acme/widget")!;
    expect(behavior).toMatchObject({
      githubOrg: "acme",
      personalDms: false,
      authorDms: false,
      mentionDms: false,
      ignoreBots: false,
      ciNotifications: false,
    });
    expect(behavior.destinations[0].channels).toEqual([]);
    expect(isMuted(behavior, "globalmute")).toBe(true);
    expect(isMuted(behavior, "REPOMUTE")).toBe(true);
    expect(behavior.emojisForWorkspace("eng")).toMatchObject({
      opened: "rule_open",
      merged: "shipit",
    });
  });

  it("infers the only configured GitHub org", () => {
    const config = testConfig({ defaultGithubOrg: null });
    expect(resolveMapping(config, "acme/widget")?.githubOrg).toBe("acme");
  });
});
