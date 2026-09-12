import { createHmac, timingSafeEqual } from "crypto";
import { AppConfig, GithubOrgCreds } from "./types";

function verifyWithSecret(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(provided, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface AuthResult {
  ok: true;
  org: string;
  creds: GithubOrgCreds;
}

export interface AuthFailure {
  ok: false;
  statusCode: 401 | 403;
  reason: string;
}

/**
 * Two-layer auth:
 * 1. HMAC-SHA256 against a configured webhook_secret → 401 if none match
 * 2. repository.owner.login must be allowlisted and own the matching secret
 */
export function authenticateWebhook(
  config: AppConfig,
  rawBody: string,
  signatureHeader: string | undefined,
  ownerLogin: string | undefined,
): AuthResult | AuthFailure {
  if (!signatureHeader) {
    return { ok: false, statusCode: 401, reason: "missing_signature" };
  }

  let matchedSecretOrg: string | null = null;
  for (const [org, creds] of Object.entries(config.githubOrgs)) {
    if (verifyWithSecret(rawBody, signatureHeader, creds.webhook_secret)) {
      matchedSecretOrg = org;
      break;
    }
  }

  if (!matchedSecretOrg) {
    return { ok: false, statusCode: 401, reason: "invalid_signature" };
  }

  if (!ownerLogin) {
    return { ok: false, statusCode: 403, reason: "missing_owner" };
  }

  // Case-insensitive org allowlist lookup
  const ownerKey = Object.keys(config.githubOrgs).find(
    (k) => k.toLowerCase() === ownerLogin.toLowerCase(),
  );
  if (!ownerKey) {
    return { ok: false, statusCode: 403, reason: "org_not_allowlisted" };
  }

  if (matchedSecretOrg.toLowerCase() !== ownerKey.toLowerCase()) {
    return { ok: false, statusCode: 401, reason: "signature_org_mismatch" };
  }

  return {
    ok: true,
    org: ownerKey,
    creds: config.githubOrgs[ownerKey],
  };
}
