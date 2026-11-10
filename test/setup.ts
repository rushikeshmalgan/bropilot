// Runs before every test file. Nothing in the app imports from test/.
import { vi } from "vitest"

// Tests must never reach a real outside service, whatever .env.local holds.
// With these unset the app sees every provider as "not configured", and a
// test that wants one passes in a fake.
for (const name of [
  "TRIGGER_SECRET_KEY",
  "FIRECRAWL_API_KEY",
  "DAYTONA_API_KEY",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "BILLING_STUB_PLAN",
]) {
  delete process.env[name]
}

// Server actions call revalidatePath, which only works inside a Next.js request.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}))

// Clerk needs a real browser session. Tests choose who is signed in through
// test/helpers/session.ts instead; the app's own auth checks run unchanged.
vi.mock("@clerk/nextjs/server", async () => {
  const { session } = await import("./helpers/session")

  const auth = async () => ({ userId: session.userId })
  auth.protect = async () => {
    if (!session.userId) {
      throw new Error("Not signed in")
    }
    return { userId: session.userId }
  }

  return { auth }
})
