// Queries for runs. A run belongs to the chat's owner; every function that
// takes a user ID treats a run in someone else's chat as if it didn't exist.
import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { MAX_RUN_DURATION_MS, RUN_TIMEOUT_MESSAGE } from "@/lib/ai"
import type { ChatMessage, RunSnapshot } from "@/lib/chat-types"
import { db } from "@/lib/db"
import {
  ACTIVE_RUN_STATUSES,
  chats,
  messages,
  runs,
  type MessagePart,
  type Run,
  type RunStatus,
} from "@/lib/db/schema"
import { getRunQueue } from "@/lib/providers"

// A run that hasn't finished this long after it should have is treated as
// stuck. The margin covers the time a worker needs to save its last write.
const STALE_GRACE_MS = 15_000

// Whether an unfinished run has outlived the time a run may take.
export function isStaleRun(run: Pick<Run, "startedAt" | "createdAt">) {
  const began = (run.startedAt ?? run.createdAt).getTime()
  return Date.now() - began > MAX_RUN_DURATION_MS + STALE_GRACE_MS
}

function toChatMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    botId: row.botId,
    parts: row.parts,
    status: row.status,
  }
}

function toSnapshot(
  run: Run,
  message: typeof messages.$inferSelect | null
): RunSnapshot {
  return {
    id: run.id,
    status: run.status,
    error: run.error,
    assistantMessageId: run.assistantMessageId,
    botId: run.botId,
    message: message ? toChatMessage(message) : null,
  }
}

function errorParts(text: string): string {
  const parts: MessagePart[] = [{ type: "text", text }]
  return JSON.stringify(parts)
}

// A run in one of the user's chats, with its reply so far. Null if the run
// doesn't exist or belongs to someone else.
export async function getRunWithMessage(userId: string, runId: string) {
  const [row] = await db
    .select({ run: runs, message: messages })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .leftJoin(messages, eq(messages.id, runs.assistantMessageId))
    .where(and(eq(runs.id, runId), eq(chats.userId, userId)))
    .limit(1)

  return row
    ? { run: row.run, snapshot: toSnapshot(row.run, row.message) }
    : null
}

export async function getRunSnapshot(
  userId: string,
  runId: string
): Promise<RunSnapshot | null> {
  return (await getRunWithMessage(userId, runId))?.snapshot ?? null
}

async function selectRunForUser(userId: string, runId: string) {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .where(and(eq(runs.id, runId), eq(chats.userId, userId)))
    .limit(1)

  return row?.run ?? null
}

// The unfinished run in one of the user's chats, if there is one.
export async function selectActiveRun(userId: string, chatId: string) {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .where(
      and(
        eq(runs.chatId, chatId),
        eq(chats.userId, userId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES])
      )
    )
    .orderBy(desc(runs.createdAt))
    .limit(1)

  return row?.run ?? null
}

// Tidies a chat whose run stopped without finishing:
// - a run still queued or running past the maximum duration is marked failed,
//   and its reply becomes an error message the user can see;
// - a reply left "streaming" with no unfinished run behind it is closed.
// Safe to call at any time; it does nothing to a healthy chat.
export async function sweepChat(chatId: string) {
  const staleSeconds = (MAX_RUN_DURATION_MS + STALE_GRACE_MS) / 1000
  const orphaned = sql`status = 'streaming' and chat_id = ${chatId} and not exists (
    select 1 from runs r
    where r.assistant_message_id = messages.id and r.status in ('queued', 'running')
  )`

  await db.execute(sql`
    with stale as (
      update runs
      set status = 'error', error = ${RUN_TIMEOUT_MESSAGE}, finished_at = now()
      where chat_id = ${chatId}
        and status in ('queued', 'running')
        and coalesce(started_at, created_at) < now() - make_interval(secs => ${staleSeconds})
      returning chat_id, bot_id, assistant_message_id
    )
    insert into messages (id, chat_id, role, bot_id, parts, status)
    select assistant_message_id, chat_id, 'assistant', bot_id, ${errorParts(RUN_TIMEOUT_MESSAGE)}::jsonb, 'error'
    from stale
    on conflict (id) do update set parts = excluded.parts, status = 'error'
  `)

  await db.batch([
    db.execute(sql`delete from messages where ${orphaned} and parts = '[]'::jsonb`),
    db.execute(sql`update messages set status = 'done' where ${orphaned}`),
  ])
}

// Marks an unfinished run as failed and leaves an error message in the chat.
// Does nothing if the run already finished or was stopped.
//
// One statement: the error message is written only if THIS call is the one that
// changed the run. A worker that was given up on (swept as stuck) and fails
// later can't bring back an error message the user has since replaced by
// retrying.
export async function failRun(
  run: Pick<Run, "id" | "chatId" | "botId" | "assistantMessageId">,
  message: string,
  from: RunStatus[] = ["running"]
) {
  const statuses = sql.join(
    from.map((status) => sql`${status}`),
    sql`, `
  )

  await db.execute(sql`
    with failed as (
      update runs
      set status = 'error', error = ${message}, finished_at = now()
      where id = ${run.id} and status in (${statuses})
      returning id
    )
    insert into messages (id, chat_id, role, bot_id, parts, status)
    select ${run.assistantMessageId}, ${run.chatId}, 'assistant', ${run.botId}, ${errorParts(message)}::jsonb, 'error'
    where exists (select 1 from failed)
    on conflict (id) do update set parts = excluded.parts, status = 'error'
  `)
}

// failRun for a run known only by its ID. Used when a worker gives up on it.
export async function failRunById(runId: string, message: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  if (run) {
    await failRun(run, message, ["queued", "running"])
  }
}

// The statements that stop one run: the run becomes "cancelled" only if it was
// still unfinished, and only then is its reply closed. Text that had already
// been saved is kept; a reply with no text yet is removed.
function cancelStatements(run: Pick<Run, "id" | "assistantMessageId">) {
  const wasCancelled = sql`exists (
    select 1 from runs where id = ${run.id} and status = 'cancelled'
  )`

  return [
    db
      .update(runs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(
        and(eq(runs.id, run.id), inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
      ),
    db.execute(sql`
      delete from messages
      where id = ${run.assistantMessageId} and status = 'streaming'
        and parts = '[]'::jsonb and ${wasCancelled}
    `),
    db.execute(sql`
      update messages set status = 'done'
      where id = ${run.assistantMessageId} and status = 'streaming' and ${wasCancelled}
    `),
  ] as const
}

// Tells the queue to stop working on a run. The database already says the run
// is over, so a failure here only wastes a little compute.
async function cancelInQueue(run: Pick<Run, "id" | "triggerRunId">) {
  if (!run.triggerRunId) {
    return
  }

  try {
    await getRunQueue()?.cancel(run.triggerRunId)
  } catch (error) {
    console.error(
      `Couldn't cancel run ${run.id} in the queue:`,
      error instanceof Error ? error.message : error
    )
  }
}

// Stops a run the user owns and returns where it ended up. If the run had
// already finished, nothing changes and the finished state is returned.
export async function cancelRun(
  userId: string,
  runId: string
): Promise<RunSnapshot | null> {
  const run = await selectRunForUser(userId, runId)
  if (!run) {
    return null
  }

  if (run.status === "queued" || run.status === "running") {
    await db.batch(cancelStatements(run))
    await cancelInQueue(run)
  }

  return getRunSnapshot(userId, runId)
}

// Stops whatever is still running in one of the user's chats.
export async function cancelActiveRuns(userId: string, chatId: string) {
  const active = await selectActiveRun(userId, chatId)
  if (!active) {
    return
  }

  await db.batch(cancelStatements(active))
  await cancelInQueue(active)
}

// Stops every unfinished reply by one of the user's bots, in any of their
// chats. Used when the bot is deleted.
export async function cancelActiveRunsForBot(userId: string, botId: string) {
  const active = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(chats, eq(chats.id, runs.chatId))
    .where(
      and(
        eq(runs.botId, botId),
        eq(chats.userId, userId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES])
      )
    )

  for (const { run } of active) {
    await db.batch(cancelStatements(run))
    await cancelInQueue(run)
  }
}

