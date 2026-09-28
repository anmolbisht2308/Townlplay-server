import * as Sentry from "@sentry/node";
import type { Env } from "./env.js";

/** No-op without SENTRY_DSN; `Sentry.captureException` is then a no-op too. */
export function initSentry(env: Pick<Env, "SENTRY_DSN" | "NODE_ENV" | "APP_VERSION">): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.APP_VERSION,
    tracesSampleRate: 0.1,
  });
}
