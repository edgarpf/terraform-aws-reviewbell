import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = mocks.send;
  },
  GetParameterCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const originalEnv = { ...process.env };

async function freshConfigModule() {
  vi.resetModules();
  return import("../../src/lib/config");
}

describe("environment and SSM configuration loading", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    process.env = {
      ...originalEnv,
      PR_TABLE: "table",
      GITHUB_ORGS_PARAM: "/reviewbell/github",
      SLACK_WORKSPACES_PARAM: "/reviewbell/slack",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("loads and caches SecureString values while parsing all environment overrides", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Parameter: {
          Value: JSON.stringify({
            acme: { webhook_secret: "secret", token: "token" },
          }),
        },
      })
      .mockResolvedValueOnce({
        Parameter: { Value: JSON.stringify({ eng: { bot_token: "slack" } }) },
      });
    Object.assign(process.env, {
      DEFAULT_GITHUB_ORG: "acme",
      GITHUB_API_BASE_URL: "https://github.example/api/v3",
      MAPPINGS: JSON.stringify([
        { repo: "*", destinations: [{ workspace: "eng", channels: [] }] },
      ]),
      DEFAULT_MAPPING: "null",
      USER_MAP: JSON.stringify({ alice: "U1" }),
      MUTED_USERS: JSON.stringify(["bot"]),
      PERSONAL_DMS: "0",
      AUTHOR_DMS: "false",
      MENTION_DMS: "1",
      IGNORE_BOTS: "true",
      CI_NOTIFICATIONS: "false",
      EMOJIS: JSON.stringify({ opened: "eyes" }),
    });

    const { loadConfig } = await freshConfigModule();
    const config = await loadConfig();
    expect(config).toMatchObject({
      tableName: "table",
      defaultGithubOrg: "acme",
      githubApiBaseUrl: "https://github.example/api/v3",
      userMap: { alice: "U1" },
      mutedUsers: ["bot"],
      personalDms: false,
      authorDms: false,
      mentionDms: true,
      ignoreBots: true,
      ciNotifications: false,
    });
    expect(config.emojis.opened).toBe("eyes");
    expect(await loadConfig()).toEqual(config);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("uses defaults for absent, empty, null, and malformed environment values", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Parameter: { Value: '{"acme":{"webhook_secret":"s","token":"t"}}' },
      })
      .mockResolvedValueOnce({ Parameter: { Value: '{"eng":{"bot_token":"x"}}' } });
    Object.assign(process.env, {
      MAPPINGS: "not-json",
      DEFAULT_MAPPING: "null",
      USER_MAP: "",
      MUTED_USERS: "null",
      PERSONAL_DMS: "",
    });
    delete process.env.DEFAULT_GITHUB_ORG;
    delete process.env.GITHUB_API_BASE_URL;
    const { loadConfig } = await freshConfigModule();
    const config = await loadConfig();
    expect(config.mappings).toEqual([]);
    expect(config.defaultMapping).toBeNull();
    expect(config.userMap).toEqual({});
    expect(config.mutedUsers).toEqual([]);
    expect(config.personalDms).toBe(true);
    expect(config.defaultGithubOrg).toBeNull();
    expect(config.githubApiBaseUrl).toBeNull();
  });

  it("rejects missing environment variables and empty SSM parameters", async () => {
    delete process.env.GITHUB_ORGS_PARAM;
    const first = await freshConfigModule();
    await expect(first.loadConfig()).rejects.toThrow(
      "GITHUB_ORGS_PARAM and SLACK_WORKSPACES_PARAM are required",
    );

    process.env.GITHUB_ORGS_PARAM = "/reviewbell/github";
    mocks.send.mockResolvedValue({ Parameter: {} });
    const second = await freshConfigModule();
    await expect(second.loadConfig()).rejects.toThrow("is empty");
  });

  it("requires PR_TABLE after secrets have loaded", async () => {
    delete process.env.PR_TABLE;
    mocks.send
      .mockResolvedValueOnce({ Parameter: { Value: "{}" } })
      .mockResolvedValueOnce({ Parameter: { Value: "{}" } });
    const { loadConfig } = await freshConfigModule();
    await expect(loadConfig()).rejects.toThrow("PR_TABLE is required");
  });
});
