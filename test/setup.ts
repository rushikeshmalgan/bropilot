// Runs before every test file. Nothing in the app imports from test/.
import { beforeEach, vi } from "vitest"

import { overridePlanResolver } from "@/lib/billing"

// Tests must never reach a real outside service, whatever .env.local holds.
// With these unset the app sees every provider as "not configured", and a
// test that wants one passes in a fake.
for (const name of [
  "TRIGGER_SECRET_KEY",
  "FIRECRAWL_API_KEY",
  "DAYTONA_API_KEY",
  "DAYTONA_SNAPSHOT",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "BILLING_STUB_PLAN",
  "BILLING_PROVIDER",
]) {
  delete process.env[name]
}

// Server actions call revalidatePath, which only works inside a Next.js request.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))

// Clerk needs a real browser session. Tests choose who is signed in, and which
// plans they hold, through test/helpers/session.ts instead; the app's own auth
// checks run unchanged.
vi.mock("@clerk/nextjs/server", async () => {
  const { session } = await import("./helpers/session")

  const auth = async () => ({
    userId: session.userId,
    has: ({ plan }: { plan?: string }) => {
      // A test can make the plan check fail, as it does when billing isn't set up.
      if (session.plans.includes("__throws__")) {
        throw new Error("Billing is not enabled")
      }
      return plan !== undefined && session.plans.includes(plan)
    },
  })
  auth.protect = async () => {
    if (!session.userId) {
      throw new Error("Not signed in")
    }
    return { userId: session.userId }
  }

  return { auth }
})

// Most tests are about something other than plans, so they run as Pro: every
// tool is on offer and no limit gets in the way. Tests about plans replace this
// (overridePlanResolver) or turn it off (overridePlanResolver(null)).
beforeEach(() => {
  overridePlanResolver({ getPlan: async () => "pro" })
})
