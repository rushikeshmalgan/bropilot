// Every environment variable this app reads, in one place: what it is for, where
// it must be set, and what happens without it. The README's table, the startup
// log, /api/health and `npm run check:env` all come from this list, and a test
// fails if the app reads a variable that isn't here.
//
// Only names are ever shown. A value is never read into a message or a log.

// Where a variable has to be set for the thing it feeds to work:
//   web     the Next.js server (Railway, or `npm run dev`)
//   worker  the Trigger.dev worker (the Trigger.dev environment, or
//           `trigger dev` reading .env.local)
//   build   `next build` (Railway's build step)
//   tools   scripts run by hand (db:push, smoke checks)
export type EnvScope = "web" | "worker" | "build" | "tools"

export type EnvVariable = {
  name: string
  // required: the app can't work without it.
  // optional: a feature turns on with it; without it the feature says it isn't
  //           set up and nothing else is affected.
  // development: only read outside production.
  kind: "required" | "optional" | "development"
  scopes: EnvScope[]
  purpose: string
  // What a person sees without it (optional variables).
  without?: string
  // The feature it switches on, as named by checkEnvironment.
  feature?: Feature
}

export type Feature =
  | "replies"
  | "web tools"
  | "sandboxes"
  | "error tracking"

export const ENV_VARIABLES: EnvVariable[] = [
  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    kind: "required",
    scopes: ["web", "build"],
    purpose: "Clerk publishable key (sign-in)",
  },
  {
    name: "CLERK_SECRET_KEY",
    kind: "required",
    scopes: ["web"],
    purpose: "Clerk secret key (checks who is signed in)",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
    kind: "optional",
    scopes: ["web", "build"],
    purpose: "Path of the Clerk sign-in page (/sign-in)",
    without: "Clerk's default is used",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
    kind: "optional",
    scopes: ["web", "build"],
    purpose: "Path of the Clerk sign-up page (/sign-up)",
    without: "Clerk's default is used",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL",
    kind: "optional",
    scopes: ["web", "build"],
    purpose: "Where Clerk sends people after signing in (/)",
    without: "Clerk's default is used",
  },
  {
    name: "NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL",
    kind: "optional",
    scopes: ["web", "build"],
    purpose: "Where Clerk sends people after signing up (/)",
    without: "Clerk's default is used",
  },
  {
    name: "DATABASE_URL",
    kind: "required",
    scopes: ["web", "worker", "tools"],
    purpose: "Neon pooled connection string",
  },
  {
    name: "DATABASE_URL_UNPOOLED",
    kind: "optional",
    scopes: ["tools"],
    purpose: "Neon direct connection string, used by `npm run db:push`",
    without: "db:push can't run",
  },
  {
    name: "NEON_BRANCH",
    kind: "optional",
    scopes: ["tools"],
    purpose: "Neon branch the other Neon variables were pulled for",
    without: "nothing; it is a note for people",
  },
  {
    name: "GOOGLE_GENERATIVE_AI_API_KEY",
    kind: "required",
    scopes: ["worker", "tools"],
    purpose: "Google Gemini API key; the model is called from the worker",
  },
  {
    name: "TRIGGER_SECRET_KEY",
    kind: "optional",
    scopes: ["web", "tools"],
    purpose:
      "Trigger.dev secret key (tr_dev_... or tr_prod_...) that queues bot replies",
    without: "messages can't be sent: the chat says replies aren't set up",
    feature: "replies",
  },
  {
    name: "FIRECRAWL_API_KEY",
    kind: "optional",
    scopes: ["worker", "tools"],
    purpose: "Firecrawl API key for the bots' web search and page reading",
    without: "bots have no web tools and say they can't browse",
    feature: "web tools",
  },
  {
    name: "DAYTONA_API_KEY",
    kind: "optional",
    scopes: ["web", "worker", "tools"],
    purpose: "Daytona API key for the bots' sandboxes and screens",
    without: "bots have no sandbox or screen; the Sandbox tab says so",
    feature: "sandboxes",
  },
  {
    name: "DAYTONA_SNAPSHOT",
    kind: "optional",
    scopes: ["web", "worker", "tools"],
    purpose: "Name of a Daytona snapshot (image with a desktop) to make sandboxes from",
    without: "Daytona's default image is used, which may not have a desktop",
  },
  {
    name: "SENTRY_DSN",
    kind: "optional",
    scopes: ["web", "worker", "build"],
    purpose: "Sentry DSN; turns on error tracking",
    without: "errors are only in the logs",
    feature: "error tracking",
  },
  {
    name: "NEXT_PUBLIC_SENTRY_DSN",
    kind: "optional",
    scopes: ["build"],
    purpose: "Sentry DSN for the browser, if it should differ from SENTRY_DSN",
    without: "SENTRY_DSN is used at build time",
  },
  {
    name: "SENTRY_TRACES_SAMPLE_RATE",
    kind: "optional",
    scopes: ["web", "worker"],
    purpose: "Share of requests and runs that send a trace, 0 to 1 (default 0.1)",
    without: "0.1",
  },
  {
    name: "SENTRY_ENVIRONMENT",
    kind: "optional",
    scopes: ["web", "worker"],
    purpose: "Environment name shown in Sentry (default: NODE_ENV)",
    without: "NODE_ENV",
  },
  {
    name: "SENTRY_AUTH_TOKEN",
    kind: "optional",
    scopes: ["build"],
    purpose: "Sentry auth token; with it the build uploads source maps",
    without: "no source maps are uploaded",
  },
  {
    name: "SENTRY_ORG",
    kind: "optional",
    scopes: ["build"],
    purpose: "Sentry organisation slug, for the source map upload",
    without: "no source maps are uploaded",
  },
  {
    name: "SENTRY_PROJECT",
    kind: "optional",
    scopes: ["build"],
    purpose: "Sentry project slug, for the source map upload",
    without: "no source maps are uploaded",
  },
  {
    name: "BILLING_PROVIDER",
    kind: "development",
    scopes: ["web"],
    purpose: "Set to `clerk` to check plans with Clerk Billing instead of the stand-in",
  },
  {
    name: "BILLING_STUB_PLAN",
    kind: "development",
    scopes: ["web"],
    purpose: "Set to `pro` to act as a Pro user; ignored in production",
  },
  {
    name: "SMOKE_SECRET_CANARY",
    kind: "development",
    scopes: ["tools"],
    purpose: "Used by scripts/smoke-daytona.ts to prove a secret isn't visible in a sandbox",
  },
]

// Variables the framework or the host sets, which this app reads but doesn't
// ask anyone to configure.
export const FRAMEWORK_VARIABLES = [
  "NODE_ENV",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "CI",
  "PORT",
]

type Env = Record<string, string | undefined>

// A secret as it would be sent in a header: printable ASCII with no spaces.
// A value copied from a masked display ("tr_dev_ab••••") isn't one, and using
// it would only fail later with a confusing error, so it counts as not set.
export function isUsableSecret(value: string | undefined): value is string {
  const trimmed = value?.trim()
  return Boolean(trimmed && /^[\x21-\x7e]+$/.test(trimmed))
}

// Whether a variable holds something the app can use.
function isSet(name: string, env: Env) {
  if (name === "TRIGGER_SECRET_KEY") {
    // Replies need a secret key, not the CLI's personal access token.
    const key = env[name]?.trim()
    return (
      isUsableSecret(key) && key.startsWith("tr_") && !key.startsWith("tr_pat_")
    )
  }
  if (name.endsWith("_API_KEY") || name.endsWith("_KEY")) {
    return isUsableSecret(env[name])
  }
  return Boolean(env[name]?.trim())
}

export type EnvironmentReport = {
  // Required variables that are missing or unusable, for this scope.
  missingRequired: string[]
  // Optional features that are off, with the variables that would turn them on.
  notConfigured: { feature: Feature; variables: string[]; without: string }[]
}

// What is missing for one place the app runs. Never throws.
export function checkEnvironment(
  scope: EnvScope,
  env: Env = process.env
): EnvironmentReport {
  const inScope = ENV_VARIABLES.filter((variable) =>
    variable.scopes.includes(scope)
  )

  const missingRequired = inScope
    .filter((variable) => variable.kind === "required")
    .filter((variable) => !isSet(variable.name, env))
    .map((variable) => variable.name)

  const notConfigured = inScope
    .filter((variable) => variable.feature && !isSet(variable.name, env))
    .map((variable) => ({
      feature: variable.feature as Feature,
      variables: [variable.name],
      without: variable.without ?? "",
    }))

  return { missingRequired, notConfigured }
}

// One plain sentence per problem, for a log. Names only.
export function describeEnvironment(
  scope: EnvScope,
  env: Env = process.env
): string[] {
  const report = checkEnvironment(scope, env)
  const lines: string[] = []

  if (report.missingRequired.length > 0) {
    lines.push(
      `Missing required environment variables: ${report.missingRequired.join(", ")}. See "Environment variables" in the README.`
    )
  }
  for (const item of report.notConfigured) {
    lines.push(
      `${item.feature} is off (${item.variables.join(", ")} is not set): ${item.without}.`
    )
  }
  return lines
}
