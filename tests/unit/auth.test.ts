import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { authenticateWebhook } from "../../src/lib/auth";
import { testConfig } from "../helpers/harness";

function signature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("webhook authentication", () => {
  const body = JSON.stringify({ repository: { owner: { login: "acme" } } });

  it("accepts a signature belonging to the payload organization", () => {
    const result = authenticateWebhook(testConfig(), body, signature(body, "acme-secret"), "Acme");
    expect(result).toMatchObject({ ok: true, org: "acme" });
  });

  it("rejects missing and invalid signatures", () => {
    expect(authenticateWebhook(testConfig(), body, undefined, "acme")).toMatchObject({
      ok: false,
      reason: "missing_signature",
    });
    expect(authenticateWebhook(testConfig(), body, "sha256=00", "acme")).toMatchObject({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects a secret belonging to another organization", () => {
    const config = testConfig({
      githubOrgs: {
        acme: { webhook_secret: "acme-secret", token: "acme-token" },
        globex: { webhook_secret: "globex-secret", token: "globex-token" },
      },
    });
    expect(
      authenticateWebhook(config, body, signature(body, "globex-secret"), "acme"),
    ).toMatchObject({ ok: false, reason: "signature_org_mismatch" });
  });
});
