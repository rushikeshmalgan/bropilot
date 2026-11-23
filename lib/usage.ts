// What a user has used this month, and the checks that keep them inside their
// plan. The limits themselves are in lib/plans.ts.
//
// Two rules make the checks safe when requests arrive at the same moment:
// - Starting a reply reserves it in one statement that only succeeds while the
//   month's count is under the limit, so ten parallel requests can't squeeze
//   past it. (Tokens are counted when a reply ends, so a few replies already
//   under way can finish after the limit is reached: at most one reply's worth
//   each, and a chat has only one reply at a time.)
// - A reply's tokens and sandbox time are added by a statement that marks the
//   run as counted in the same step, so a retry or a second call can't add
//   them twice.
//
// Everything here is plain SQL against the `usage` table (see lib/db/schema.ts).
import { sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/lib/db"
import { monthKey, planLimits, type PlanId } from "@/lib/plans"

export type Usage = {
  runs: number
  sandboxMinutes: number
  inputTokens: number
  outputTokens: number
}

const EMPTY: Usage = { runs: 0, sandboxMinutes: 0, inputTokens: 0, outputTokens: 0 }

type UsageRow = {
  runs: number | string
  sandbox_minutes: number | string
  input_tokens: number | string
  output_tokens: number | string
}

function toUsage(row: UsageRow | undefined): Usage {
  return row
    ? {
        runs: Number(row.runs),
        sandboxMinutes: Number(row.sandbox_minutes),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      }
    : { ...EMPTY }
}

export async function getUsage(
  userId: string,
  month: string = monthKey()
): Promise<Usage> {
  const result = await db.execute(sql`
    select runs, sandbox_minutes, input_tokens, output_tokens
    from usage where user_id = ${userId} and month = ${month}
  `)

  return toUsage(result.rows[0] as UsageRow | undefined)
}

export type Reservation =
  | { ok: true; month: string }
  | { ok: false; reason: "runs" | "tokens" }

// Takes one reply from the month's allowance, or says which limit is reached.
// The check and the count happen in one statement.
export async function reserveRun(
  userId: string,
  plan: PlanId,
  now: Date = new Date()
): Promise<Reservation> {
  const limits = planLimits(plan)
  const month = monthKey(now)

  const result = await db.execute(sql`
    insert into usage (user_id, month, runs) values (${userId}, ${month}, 1)
    on conflict (user_id, month) do update set runs = usage.runs + 1
    where usage.runs < ${limits.runsPerMonth}
      and usage.input_tokens + usage.output_tokens < ${limits.tokensPerMonth}
    returning runs
  `)

  if (result.rows.length > 0) {
    return { ok: true, month }
  }

  const used = await getUsage(userId, month)
  return { ok: false, reason: used.runs >= limits.runsPerMonth ? "runs" : "tokens" }
}

// Gives a reserved reply back, for when it never started (the chat was busy,
// say). If the process dies between reserving and releasing, the user is one
// reply down, which is the safe way to be wrong.
export async function releaseRun(userId: string, month: string) {
  await db.execute(sql`
    update usage set runs = greatest(runs - 1, 0)
    where user_id = ${userId} and month = ${month}
  `)
}

export type RunMeter = {
  inputTokens: number
  outputTokens: number
  // Seconds of sandbox time the run's tools used.
  sandboxSeconds: number
}

export function newMeter(): RunMeter {
  return { inputTokens: 0, outputTokens: 0, sandboxSeconds: 0 }
}

// Adds a finished run's tokens and sandbox time to its owner's month, once.
// Safe to call any number of times, and for a run that hasn't finished (then
// it does nothing): the run is marked as counted in the same statement that
// adds the numbers. The numbers go to the month the run was started in.
export async function recordRunUsage(
  runId: string,
  meter: RunMeter
): Promise<void> {
  const minutes = Math.ceil(Math.max(0, meter.sandboxSeconds) / 60)

  await db.execute(sql`
    with marked as (
      update runs set usage_counted_at = now()
      where id = ${runId}
        and usage_counted_at is null
        and status in ('done', 'error', 'cancelled')
      returning chat_id, to_char(created_at at time zone 'UTC', 'YYYY-MM') as month
    )
    insert into usage (user_id, month, runs, sandbox_minutes, input_tokens, output_tokens)
    select c.user_id, m.month, 0, ${minutes}, ${Math.max(0, meter.inputTokens)}, ${Math.max(0, meter.outputTokens)}
    from marked m join chats c on c.id = m.chat_id
    on conflict (user_id, month) do update set
      sandbox_minutes = usage.sandbox_minutes + excluded.sandbox_minutes,
      input_tokens = usage.input_tokens + excluded.input_tokens,
      output_tokens = usage.output_tokens + excluded.output_tokens
  `)
}

// --- Bots a plan covers ---

// The bots the plan covers: the oldest ones, up to the limit. The rest are
// kept but read-only. Newest-first would make a user's long-standing bots
// the ones to go read-only after a downgrade.
export async function activeBotIds(
  userId: string,
  plan: PlanId
): Promise<string[]> {
  const result = await db.execute(sql`
    select id from bots where user_id = ${userId}
    order by created_at asc, id asc
    limit ${planLimits(plan).maxBots}
  `)

  return result.rows.map((row) => String((row as { id: unknown }).id))
}

export async function countBots(userId: string): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from bots where user_id = ${userId}`
  )
  return Number((result.rows[0] as { count: unknown } | undefined)?.count ?? 0)
}

export type NewBotValues = {
  name: string
  job: string
  instructions: string | null
  avatar: string
}

// Creates a bot unless the user already has as many as the plan allows. The
// count and the insert run in one transaction under a lock for this user, so
// parallel requests are counted one after another and can't pass the limit.
export async function createBotWithinLimit(
  userId: string,
  values: NewBotValues,
  plan: PlanId
): Promise<{ id: string } | null> {
  const id = nanoid()
  const max = planLimits(plan).maxBots

  const [, inserted] = await db.batch([
    db.execute(sql`select pg_advisory_xact_lock(hashtext(${`bots:${userId}`}))`),
    db.execute(sql`
      insert into bots (id, user_id, name, avatar, job, instructions)
      select ${id}, ${userId}, ${values.name}, ${values.avatar}, ${values.job}, ${values.instructions}
      where (select count(*) from bots where user_id = ${userId}) < ${max}
      returning id
    `),
  ])

  return inserted.rows.length > 0 ? { id } : null
}

// --- What the sidebar shows ---

export type UsageSummary = {
  plan: string
  runs: { used: number; max: number }
  tokens: { used: number; max: number }
  bots: { used: number; max: number }
}

export async function getUsageSummary(
  userId: string,
  plan: PlanId
): Promise<UsageSummary> {
  const limits = planLimits(plan)
  const [used, bots] = await Promise.all([getUsage(userId), countBots(userId)])

  return {
    plan: limits.name,
    runs: { used: used.runs, max: limits.runsPerMonth },
    tokens: { used: used.inputTokens + used.outputTokens, max: limits.tokensPerMonth },
    bots: { used: bots, max: limits.maxBots },
  }
}
