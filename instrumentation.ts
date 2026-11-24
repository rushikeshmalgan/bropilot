// Starts Sentry for the Next.js server, and only when SENTRY_DSN is set.
// Without it nothing is imported and nothing is sent.
//
// Sentry docs: https://docs.sentry.io/platforms/javascript/guides/nextjs/
// (manual setup: instrumentation.ts, sentry.server.config.ts,
// sentry.edge.config.ts).
import type { Instrumentation } from "next"

export async function register() {
  if (!process.env.SENTRY_DSN) {
    return
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config")
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config")
  }
}

// Errors thrown while rendering a page, running a route or a server action.
export const onRequestError: Instrumentation.onRequestError = async (
  ...args
) => {
  if (!process.env.SENTRY_DSN) {
    return
  }
  const Sentry = await import("@sentry/nextjs")
  return Sentry.captureRequestError(...args)
}
