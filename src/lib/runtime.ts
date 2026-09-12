import {
  claimDelivery,
  completeDelivery,
  createPrIfAbsent,
  getEffect,
  getPr,
  putEffect,
  putPr,
  releaseDelivery,
} from "./store";
import {
  addReaction,
  openDm,
  postMessage,
  resolveChannelId,
  updateMessage,
} from "./slack";
import { resolveGithubToSlack } from "./github";
import type {
  NotificationDependencies,
  ProcessDependencies,
  SlackPort,
  StorePort,
} from "./dependencies";

export const productionStore: StorePort = {
  claimDelivery,
  completeDelivery,
  releaseDelivery,
  getPr,
  createPrIfAbsent,
  putPr,
  getEffect,
  putEffect,
};

export const productionSlack: SlackPort = {
  postMessage,
  updateMessage,
  openDm,
  addReaction,
  resolveChannelId,
};

export const productionNotifications: NotificationDependencies = {
  store: productionStore,
  slack: productionSlack,
  users: {
    resolve: (config, githubToken, githubLogin, workspaceOrder) =>
      resolveGithubToSlack(config, githubToken, githubLogin, workspaceOrder),
  },
};

export const productionProcessDependencies: ProcessDependencies = {
  store: productionStore,
  notifications: productionNotifications,
};
