import type {
  APIGatewayProxyStructuredResultV2,
  LambdaFunctionURLEvent,
} from "aws-lambda";
import { loadConfig } from "./lib/config";
import { authenticateWebhook } from "./lib/auth";
import { processEvent } from "./process";
import { log } from "./lib/logger";
import { productionProcessDependencies, productionStore } from "./lib/runtime";
import type { AppConfig } from "./lib/types";
import type { ProcessDependencies, StorePort } from "./lib/dependencies";
import { randomUUID } from "crypto";

const DELIVERY_LEASE_SECONDS = 5 * 60;

export interface HandlerDependencies {
  loadConfig(): Promise<AppConfig>;
  authenticateWebhook: typeof authenticateWebhook;
  processEvent: typeof processEvent;
  processDependencies: ProcessDependencies;
  store: Pick<StorePort, "claimDelivery" | "completeDelivery" | "releaseDelivery">;
  now(): number;
  newLeaseId(deliveryId: string): string;
}

export const productionHandlerDependencies: HandlerDependencies = {
  loadConfig,
  authenticateWebhook,
  processEvent,
  processDependencies: productionProcessDependencies,
  store: productionStore,
  now: () => Math.floor(Date.now() / 1000),
  newLeaseId: () => randomUUID(),
};

function header(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function response(statusCode: number, body: string): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body,
  };
}

export function createHandler(deps: HandlerDependencies) {
  return async function reviewBellHandler(
    event: LambdaFunctionURLEvent,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const method = event.requestContext?.http?.method;
    if (method && method !== "POST") {
      return response(405, JSON.stringify({ error: "method_not_allowed" }));
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : (event.body ?? "");

    const deliveryId = header(event.headers, "x-github-delivery") ?? "unknown";
    const eventName = header(event.headers, "x-github-event") ?? "unknown";
    const signature = header(event.headers, "x-hub-signature-256");

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      log.warn("invalid_json", { delivery_id: deliveryId, event: eventName });
      return response(400, JSON.stringify({ error: "invalid_json" }));
    }

    const ownerLogin =
      (payload.repository as { owner?: { login?: string } } | undefined)?.owner?.login;

    let config;
    try {
      config = await deps.loadConfig();
    } catch (err) {
      log.error("event_failed", {
        delivery_id: deliveryId,
        event: eventName,
        phase: "config_load",
        error_class: (err as Error).name,
        outcome: "error",
      });
      return response(500, JSON.stringify({ error: "config_error" }));
    }

    const auth = deps.authenticateWebhook(config, rawBody, signature, ownerLogin);
    if (!auth.ok) {
      log.warn("auth_failed", {
        delivery_id: deliveryId,
        event: eventName,
        decision: auth.reason,
        outcome: "rejected",
      });
      return response(auth.statusCode, JSON.stringify({ error: auth.reason }));
    }

    const leaseId = deps.newLeaseId(deliveryId);
    let claimed = false;
    try {
      if (deliveryId !== "unknown") {
        const claim = await deps.store.claimDelivery(
          config.tableName,
          deliveryId,
          deps.now(),
          DELIVERY_LEASE_SECONDS,
          leaseId,
        );
        if (claim !== "claimed") {
          log.info("delivery_dedup", {
            delivery_id: deliveryId,
            event: eventName,
            decision: claim,
            outcome: "ok",
          });
          return response(200, JSON.stringify({ ok: true, dedup: true, state: claim }));
        }
        claimed = true;
      }

      await deps.processEvent(
        {
          config,
          githubToken: auth.creds.token,
          deliveryId,
          eventName,
          payload,
        },
        deps.processDependencies,
      );
      if (deliveryId !== "unknown") {
        await deps.store.completeDelivery(config.tableName, deliveryId, deps.now(), leaseId);
      }
      log.info("event_processed", {
        delivery_id: deliveryId,
        event: eventName,
        outcome: "ok",
      });
      return response(200, JSON.stringify({ ok: true }));
    } catch (err) {
      if (claimed) {
        try {
          await deps.store.releaseDelivery(config.tableName, deliveryId, leaseId);
        } catch (releaseErr) {
          log.error("delivery_release_failed", {
            delivery_id: deliveryId,
            error_class: (releaseErr as Error).name,
          });
        }
      }
      log.error("event_failed", {
        delivery_id: deliveryId,
        event: eventName,
        error_class: (err as Error).name,
        outcome: "error",
      });
      return response(500, JSON.stringify({ error: "processing_failed" }));
    }
  };
}

export const handler = createHandler(productionHandlerDependencies);
