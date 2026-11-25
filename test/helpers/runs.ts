import { asc, eq, sql } from "drizzle-orm"

import { startRun } from "@/lib/agent/start-run"
import { insertChat } from "@/lib/chat-store"
import { textOfParts } from "@/lib/chat-types"
import type { PlanId } from "@/lib/plans"
import { db } from "@/lib/db"
import { messages, runs } from "@/lib/db/schema"

// A new one-on-one chat with the bot.
export async function newChat(userId: string, botId: string) {
  const chatId = await insertChat(userId, { botIds: [botId] })
  if (!chatId) {
    throw new Error("Couldn't create the test chat")
  }
  return chatId
}

// Sends a message the way the chat route does and returns the started run.
export async function send(
  userId: string,
  chatId: string,
  text = "Hello",
  plan: PlanId = "pro"
) {
  const result = await startRun({ userId, chatId, text, plan })
  if (!result.ok) {
    throw new Error(`startRun refused: ${result.code}`)
  }
  return result
}

// A run's row and the chat's messages as the database has them now.
export async function readChat(chatId: string) {
  const [runRows, messageRows] = await Promise.all([
    db.select().from(runs).where(eq(runs.chatId, chatId)),
    db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt)),
  ])

  const replies = messageRows.filter((message) => message.role === "assistant")

  return {
    runs: runRows,
    messages: messageRows,
    replies,
    // The text of the only reply, for the common case of one.
    replyText: replies.length === 1 ? textOfParts(replies[0].parts) : null,
  }
}

// Ends every unfinished run a user has, for tests that leave replies queued
// and then keep using the same user (a user may only have a few at once).
export async function finishActiveRuns(userId: string) {
  await db.execute(sql`
    update runs set status = 'done', finished_at = now()
    where status in ('queued', 'running')
      and chat_id in (select id from chats where user_id = ${userId})
  `)
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Polls until the check passes, for things another task does in its own time.
export async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
  everyMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) {
      return value
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for a condition")
    }
    await wait(everyMs)
  }
}
