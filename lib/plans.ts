// What each plan allows. This is the one place the limits live: every check in
// the app reads from here, so changing a number here changes it everywhere.
//
// Months are calendar months in UTC (see monthKey), so a user's allowance
// resets at 00:00 UTC on the 1st, whatever their own time zone.

export type PlanId = "free" | "pro"

export type PlanLimits = {
  name: string
  // How many bots may be used. Extra bots are kept but read-only.
  maxBots: number
  // Whether bots may have a sandbox (bash and file tools).
  sandboxes: boolean
  // Whether bots may use a desktop screen. Needs a sandbox as well.
  computerUse: boolean
  // Replies started per month.
  runsPerMonth: number
  // Model tokens (input and output together) per month.
  tokensPerMonth: number
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    name: "Free",
    maxBots: 3,
    sandboxes: false,
    computerUse: false,
    runsPerMonth: 50,
    tokensPerMonth: 200_000,
  },
  pro: {
    name: "Pro",
    maxBots: 20,
    sandboxes: true,
    computerUse: true,
    runsPerMonth: 1000,
    tokensPerMonth: 5_000_000,
  },
}

export function isPlanId(value: unknown): value is PlanId {
  return value === "free" || value === "pro"
}

// A stored plan name that isn't one we know is treated as the lowest plan.
export function planLimits(plan: unknown): PlanLimits {
  return isPlanId(plan) ? PLANS[plan] : PLANS.free
}

// "2026-11": the month a use of the app is counted in.
export function monthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7)
}

// Why something was refused, in words the screen can show. `upgrade` tells the
// screen to add an upgrade prompt.
export type PlanRefusal = {
  code: "plan_limit"
  error: string
  upgrade: boolean
}

function upgradeable(plan: PlanId) {
  return plan !== "pro"
}

export function botLimitRefusal(plan: PlanId): PlanRefusal {
  const limits = PLANS[plan]
  return {
    code: "plan_limit",
    upgrade: upgradeable(plan),
    error: upgradeable(plan)
      ? `The ${limits.name} plan includes ${limits.maxBots} bots. Upgrade to Pro for up to ${PLANS.pro.maxBots}, or delete one to make room.`
      : `You've reached the limit of ${limits.maxBots} bots. Delete one to make room.`,
  }
}

export function runLimitRefusal(plan: PlanId): PlanRefusal {
  const limits = PLANS[plan]
  return {
    code: "plan_limit",
    upgrade: upgradeable(plan),
    error: upgradeable(plan)
      ? `You've used all ${limits.runsPerMonth} replies in the ${limits.name} plan this month. Upgrade to Pro for ${PLANS.pro.runsPerMonth} a month, or wait until next month.`
      : `You've used all ${limits.runsPerMonth} replies for this month. They reset at the start of next month.`,
  }
}

export function tokenLimitRefusal(plan: PlanId): PlanRefusal {
  const limits = PLANS[plan]
  return {
    code: "plan_limit",
    upgrade: upgradeable(plan),
    error: upgradeable(plan)
      ? `You've used this month's ${formatTokens(limits.tokensPerMonth)} tokens in the ${limits.name} plan. Upgrade to Pro for ${formatTokens(PLANS.pro.tokensPerMonth)}, or wait until next month.`
      : `You've used this month's ${formatTokens(limits.tokensPerMonth)} tokens. They reset at the start of next month.`,
  }
}

export function sandboxRefusal(plan: PlanId): PlanRefusal {
  return {
    code: "plan_limit",
    upgrade: upgradeable(plan),
    error: `Sandboxes aren't part of the ${PLANS[plan].name} plan. Upgrade to Pro to give your bots a computer.`,
  }
}

export function computerRefusal(plan: PlanId): PlanRefusal {
  return {
    code: "plan_limit",
    upgrade: upgradeable(plan),
    error: `Using a screen isn't part of the ${PLANS[plan].name} plan. Upgrade to Pro to let your bots use one.`,
  }
}

export const READ_ONLY_BOT_MESSAGE =
  "This bot is read-only because your plan includes fewer bots than you have. You can still read its chats and memory. Delete another bot or upgrade to use it again."

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`
  }
  if (count >= 1_000) {
    return `${Math.round(count / 1_000)}k`
  }
  return String(count)
}
