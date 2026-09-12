import { describe, expect, it, vi } from "vitest";
import { authenticateWebhook } from "../../src/lib/auth";
import { createHandler } from "../../src/index";
import { prEvent } from "../helpers/github-fixtures";
import {
  MemoryStore,
  ReviewBellHarness,
  lambdaEvent,
  testConfig,
} from "../helpers/harness";

describe("webhook boundary", () => {
  it("only accepts POST", async () => {
    const harness = new ReviewBellHarness();
    const response = await harness.send("pull_request", prEvent(), { method: "GET" });
    expect(response.statusCode).toBe(405);
    expect(JSON.parse(response.body ?? "{}")).toEqual({ error: "method_not_allowed" });
  });

  it("rejects invalid JSON before authentication", async () => {
    const harness = new ReviewBellHarness();
    const response = await harness.handler(
      lambdaEvent("pull_request", {}, { rawBody: "{not-json" }),
    );
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ["missing signature", { signature: null }, 401, "missing_signature"],
    ["invalid signature", { signature: "sha256=00" }, 401, "invalid_signature"],
  ])("rejects %s", async (_label, options, code, error) => {
    const harness = new ReviewBellHarness();
    const response = await harness.send("pull_request", prEvent(), options);
    expect(response.statusCode).toBe(code);
    expect(JSON.parse(response.body ?? "{}").error).toBe(error);
  });

  it("rejects missing and unknown payload organizations", async () => {
    const harness = new ReviewBellHarness();
    const missingOwner = prEvent();
    delete (missingOwner.repository as { owner?: unknown }).owner;
    const missing = await harness.send("pull_request", missingOwner, {
      deliveryId: "missing-owner",
    });
    expect(missing.statusCode).toBe(403);

    const unknownOwner = prEvent();
    (unknownOwner.repository as { owner: { login: string } }).owner.login = "other";
    const unknown = await harness.send("pull_request", unknownOwner, {
      deliveryId: "unknown-owner",
    });
    expect(unknown.statusCode).toBe(403);
  });

  it("rejects a signature from a different configured organization", async () => {
    const config = testConfig({
      githubOrgs: {
        acme: { webhook_secret: "acme-secret", token: "a" },
        other: { webhook_secret: "other-secret", token: "b" },
      },
    });
    const harness = new ReviewBellHarness(config);
    const response = await harness.send("pull_request", prEvent(), {
      secret: "other-secret",
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body ?? "{}").error).toBe("signature_org_mismatch");
  });

  it("decodes base64 bodies and accepts case-insensitive headers", async () => {
    const harness = new ReviewBellHarness();
    const event = lambdaEvent("pull_request", prEvent(), {
      base64: true,
      deliveryId: "base64",
    });
    event.headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([key, value]) => [key.toUpperCase(), value]),
    );
    const response = await harness.handler(event);
    expect(response.statusCode).toBe(200);
    expect(harness.pr()).not.toBeNull();
  });

  it("accepts unhandled events without side effects", async () => {
    const harness = new ReviewBellHarness();
    const response = await harness.send("ping", prEvent(), { deliveryId: "ping" });
    expect(response.statusCode).toBe(200);
    expect(harness.posts()).toHaveLength(0);
  });

  it("processes events without a delivery ID but does not deduplicate them", async () => {
    const harness = new ReviewBellHarness();
    const event = lambdaEvent("pull_request", prEvent());
    delete event.headers?.["x-github-delivery"];
    const first = await harness.handler(event);
    const second = await harness.handler(event);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(harness.store.deliveries.size).toBe(0);
  });

  it("deduplicates sequential and concurrent deliveries atomically", async () => {
    const harness = new ReviewBellHarness();
    const event = lambdaEvent("pull_request", prEvent(), { deliveryId: "same" });
    const [a, b] = await Promise.all([harness.handler(event), harness.handler(event)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(harness.posts()).toHaveLength(1);

    const third = await harness.handler(event);
    expect(JSON.parse(third.body ?? "{}")).toMatchObject({ dedup: true });
  });

  it("allows a stale processing lease to be reclaimed", async () => {
    const harness = new ReviewBellHarness();
    harness.store.deliveries.set("stale", {
      state: "processing",
      lease: harness.now - 1,
      leaseId: "expired-worker",
    });
    const response = await harness.send("pull_request", prEvent(), {
      deliveryId: "stale",
    });
    expect(response.statusCode).toBe(200);
    expect(harness.store.deliveries.get("stale")?.state).toBe("completed");
  });

  it("does not let an expired worker release or complete a reclaimed lease", async () => {
    const store = new MemoryStore();
    await store.claimDelivery("table", "delivery", 10, 5, "old-worker");
    expect(await store.claimDelivery("table", "delivery", 16, 5, "new-worker")).toBe(
      "claimed",
    );
    await store.releaseDelivery("table", "delivery", "old-worker");
    await store.completeDelivery("table", "delivery", 17, "old-worker");
    expect(store.deliveries.get("delivery")).toMatchObject({
      state: "processing",
      leaseId: "new-worker",
    });
    await store.completeDelivery("table", "delivery", 17, "new-worker");
    expect(store.deliveries.get("delivery")?.state).toBe("completed");
  });

  it("turns delivery-claim failures into retryable processing errors", async () => {
    const store = new MemoryStore();
    const release = vi.spyOn(store, "releaseDelivery");
    store.claimDelivery = vi.fn().mockRejectedValue(new Error("DynamoDB unavailable"));
    const handler = createHandler({
      loadConfig: async () => testConfig(),
      authenticateWebhook,
      processEvent: vi.fn(),
      processDependencies: {} as never,
      store,
      now: () => 1,
      newLeaseId: () => "lease",
    });
    const response = await handler(lambdaEvent("pull_request", prEvent()));
    expect(response.statusCode).toBe(500);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the claim after failure so GitHub can retry", async () => {
    const harness = new ReviewBellHarness();
    harness.slack.failNextPost = true;
    const first = await harness.send("pull_request", prEvent(), {
      deliveryId: "retryable",
    });
    expect(first.statusCode).toBe(500);
    expect(harness.store.deliveries.has("retryable")).toBe(false);

    const retry = await harness.send("pull_request", prEvent(), {
      deliveryId: "retryable",
    });
    expect(retry.statusCode).toBe(200);
    expect(harness.posts()).toHaveLength(1);
  });

  it("surfaces configuration failures without claiming a delivery", async () => {
    const store = new MemoryStore();
    const handler = createHandler({
      loadConfig: async () => {
        throw new Error("SSM unavailable");
      },
      authenticateWebhook,
      processEvent: vi.fn(),
      processDependencies: {} as never,
      store,
      now: () => 1,
      newLeaseId: () => "lease",
    });
    const response = await handler(lambdaEvent("pull_request", prEvent()));
    expect(response.statusCode).toBe(500);
    expect(store.deliveries.size).toBe(0);
  });

  it("still returns a processing failure if claim release itself fails", async () => {
    const store = new MemoryStore();
    store.releaseDelivery = vi.fn().mockRejectedValue(new Error("DynamoDB unavailable"));
    const handler = createHandler({
      loadConfig: async () => testConfig(),
      authenticateWebhook,
      processEvent: vi.fn().mockRejectedValue(new Error("bad downstream")),
      processDependencies: {} as never,
      store,
      now: () => 1,
      newLeaseId: () => "lease",
    });
    const response = await handler(lambdaEvent("pull_request", prEvent()));
    expect(response.statusCode).toBe(500);
  });
});
