interface PullRequestOptions {
  action?: string;
  draft?: boolean;
  merged?: boolean;
  title?: string;
  author?: string;
  sender?: string;
  senderType?: string;
  reviewers?: string[];
  requestedReviewer?: string;
  requestedTeam?: string;
}

function repository() {
  return {
    full_name: "acme/widget",
    owner: { login: "acme" },
  };
}

function pullRequest(options: PullRequestOptions = {}) {
  return {
    number: 42,
    title: options.title ?? "Improve ReviewBell",
    html_url: "https://github.com/acme/widget/pull/42",
    draft: options.draft ?? false,
    merged: options.merged ?? false,
    user: { login: options.author ?? "alice" },
    requested_reviewers: (options.reviewers ?? []).map((login) => ({ login })),
  };
}

export function prEvent(options: PullRequestOptions = {}): Record<string, unknown> {
  return {
    action: options.action ?? "opened",
    repository: repository(),
    pull_request: pullRequest(options),
    sender: { login: options.sender ?? "alice", type: options.senderType ?? "User" },
    ...(options.requestedReviewer
      ? { requested_reviewer: { login: options.requestedReviewer } }
      : {}),
    ...(options.requestedTeam ? { requested_team: { slug: options.requestedTeam } } : {}),
  };
}

export function reviewEvent(options: {
  action?: string;
  state?: string;
  reviewer?: string;
  author?: string;
  draft?: boolean;
  body?: string;
} = {}): Record<string, unknown> {
  return {
    action: options.action ?? "submitted",
    repository: repository(),
    pull_request: pullRequest({ draft: options.draft, author: options.author }),
    review: {
      state: options.state ?? "approved",
      body: options.body ?? "",
      html_url: "https://github.com/acme/widget/pull/42#pullrequestreview-1",
      user: { login: options.reviewer ?? "bob" },
    },
    sender: { login: options.reviewer ?? "bob", type: "User" },
  };
}

export function reviewCommentEvent(options: {
  action?: string;
  actor?: string;
  author?: string;
  draft?: boolean;
  body?: string;
} = {}): Record<string, unknown> {
  return {
    action: options.action ?? "created",
    repository: repository(),
    pull_request: pullRequest({ draft: options.draft, author: options.author }),
    comment: {
      body: options.body ?? "Looks good",
      html_url: "https://github.com/acme/widget/pull/42#discussion_r1",
      user: { login: options.actor ?? "bob" },
    },
    sender: { login: options.actor ?? "bob", type: "User" },
  };
}

export function issueCommentEvent(options: {
  action?: string;
  actor?: string;
  author?: string;
  body?: string;
  isPullRequest?: boolean;
} = {}): Record<string, unknown> {
  return {
    action: options.action ?? "created",
    repository: repository(),
    issue: {
      number: 42,
      title: "Improve ReviewBell",
      html_url: "https://github.com/acme/widget/issues/42",
      user: { login: options.author ?? "alice" },
      ...(options.isPullRequest === false
        ? {}
        : { pull_request: { html_url: "https://github.com/acme/widget/pull/42" } }),
    },
    comment: {
      body: options.body ?? "Looks good",
      html_url: "https://github.com/acme/widget/pull/42#issuecomment-1",
      user: { login: options.actor ?? "bob" },
    },
    sender: { login: options.actor ?? "bob", type: "User" },
  };
}

export function checkSuiteEvent(options: {
  action?: string;
  conclusion?: string;
  app?: string;
} = {}): Record<string, unknown> {
  return {
    action: options.action ?? "completed",
    repository: repository(),
    check_suite: {
      conclusion: options.conclusion ?? "success",
      app: { slug: options.app ?? "github-actions" },
      pull_requests: [{ number: 42 }],
    },
    sender: { login: "github-actions[bot]", type: "User" },
  };
}
