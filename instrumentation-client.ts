// Sentry in the browser. It starts only when a DSN was available when the app
// was built (NEXT_PUBLIC_SENTRY_DSN, which next.config.ts fills from
// SENTRY_DSN when it isn't set). Without one, the Sentry code is never
// downloaded.
//
// Session Replay and user feedback are not turned on: they record what is on
// the screen, which is people's conversations.
import { sentryOptions } from "@/lib/sentry-options"

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

type SentryClient = typeof import("@sentry/nextjs")
let loaded: Promise<SentryClient | null> | null = null

// The browser SDK, started on first use. Null when there is no DSN.
function loadSentry(): Promise<SentryClient | null> {
  if (!dsn) {
    return Promise.resolve(null)
  }
  loaded ??= import("@sentry/nextjs").then(
    (Sentry) => {
      Sentry.init(sentryOptions(dsn))
      return Sentry
    },
    () => null
  )
  return loaded
}

if (dsn) {
  void loadSentry()
}

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse"
) {
  void loadSentry().then((Sentry) =>
    Sentry?.captureRouterTransitionStart(url, navigationType)
  )
}
