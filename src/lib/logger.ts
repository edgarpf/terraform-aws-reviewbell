type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  delivery_id?: string;
  repo?: string;
  pr?: number;
  event?: string;
  action?: string;
  decision?: string;
  outcome?: string;
  error_class?: string;
  github_user?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  "token",
  "bot_token",
  "webhook_secret",
  "authorization",
  "x-hub-signature-256",
  "body",
  "payload",
]);

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    message,
    time: new Date().toISOString(),
    ...sanitize(fields),
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
