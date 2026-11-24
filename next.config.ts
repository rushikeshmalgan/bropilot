import type { NextConfig } from "next"
import { withSentryConfig } from "@sentry/nextjs/config"

const dsn = process.env.SENTRY_DSN
const authToken = process.env.SENTRY_AUTH_TOKEN

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  env: {
    // The browser can only read variables named NEXT_PUBLIC_*. A DSN isn't a
    // secret (it is in every page that uses it), so one SENTRY_DSN is enough:
    // it is copied here when the app is built. Empty means no browser reports.
    NEXT_PUBLIC_SENTRY_DSN:
      process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN ?? "",
  },
}

// Sentry's build step is only added when there is something for it to do.
// Without a DSN or an auth token the build is the plain Next.js build.
export default dsn || authToken || process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken,
      // Nothing is sent to Sentry about the build itself.
      telemetry: false,
      silent: true,
      // Source maps are uploaded only when there is a token to upload them
      // with. Without one the build is unchanged and stack traces in Sentry
      // show the built code.
      sourcemaps: { disable: !authToken },
    })
  : nextConfig
