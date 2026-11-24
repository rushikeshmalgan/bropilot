// Sentry for the edge runtime. Loaded by instrumentation.ts, and only when
// SENTRY_DSN is set. This app has no edge routes today; the file is here so one
// added later is covered by the same rules.
import * as Sentry from "@sentry/nextjs"

import { sentryOptions } from "@/lib/sentry-options"

const dsn = process.env.SENTRY_DSN
if (dsn) {
  Sentry.init(sentryOptions(dsn))
}
