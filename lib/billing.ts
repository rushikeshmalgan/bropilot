// Which plan a user is on. Everything else asks getPlan and never looks at
// billing directly.
//
// There are two sources:
// - Clerk Billing, read with has({ plan }) on the user's session. This is the
//   real one and the only one used in production.
// - A stand-in for development: Free, or Pro when BILLING_STUB_PLAN=pro. It is
//   never used when NODE_ENV is "production", whatever the variable says, so a
//   leftover setting can't hand out Pro on a live server.
//
// Clerk's check needs the user's own session, so getPlan only works inside a
// request (a route, a server action or a page). Background work doesn't call
// it: the plan is read when a reply is started and saved on the run.
import { auth } from "@clerk/nextjs/server"

import type { PlanId } from "@/lib/plans"

// The slug of the paid plan in the Clerk dashboard (Billing > Plans).
export const CLERK_PRO_PLAN_SLUG = "pro"

export interface PlanResolver {
  getPlan(userId: string): Promise<PlanId>
}

// Reads the plan from Clerk Billing. Written from Clerk's billing guide:
// `const { has } = await auth()` then `has({ plan: "<slug>" })`.
export const clerkPlanResolver: PlanResolver = {
  async getPlan(userId) {
    const session = await auth()

    // has() describes the signed-in user. If someone asks about another user,
    // there is nothing to read, so they get the lowest plan.
    if (session.userId !== userId) {
      return "free"
    }

    try {
      return session.has({ plan: CLERK_PRO_PLAN_SLUG }) ? "pro" : "free"
    } catch (error) {
      // Billing not enabled, or Clerk unreachable: Free, never Pro.
      console.error(
        "Couldn't check the plan with Clerk:",
        error instanceof Error ? error.name : "unknown error"
      )
      return "free"
    }
  },
}

// The development stand-in.
export const stubPlanResolver: PlanResolver = {
  async getPlan() {
    return process.env.BILLING_STUB_PLAN === "pro" ? "pro" : "free"
  },
}

// Tests replace the resolver through this. The app itself never calls it.
let override: PlanResolver | null = null

export function overridePlanResolver(resolver: PlanResolver | null) {
  override = resolver
}

function activeResolver(): PlanResolver {
  if (override) {
    return override
  }
  if (process.env.NODE_ENV === "production") {
    return clerkPlanResolver
  }
  // In development the real check can be turned on to try it.
  return process.env.BILLING_PROVIDER === "clerk"
    ? clerkPlanResolver
    : stubPlanResolver
}

export async function getPlan(userId: string): Promise<PlanId> {
  return activeResolver().getPlan(userId)
}
