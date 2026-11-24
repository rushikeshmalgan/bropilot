// Sentry for the Next.js server (Node). Loaded by instrumentation.ts, and only
// when SENTRY_DSN is set. The options, including everything that keeps message
// text and keys out of events, are shared: lib/sentry-options.ts.
import * as Sentry from "@sentry/nextjs"

import { sentryOptions } from "@/lib/sentry-options"

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init(sentryOptions(dsn))
}
