import { asc, eq } from "drizzle-orm"

import { startRun } from "@/lib/agent/start-run"
import { insertChat } from "@/lib/chat-store"
import { textOfParts } from "@/lib/chat-types"
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
export async function send(userId: string, chatId: string, text = "Hello") {
  const result = await startRun({ userId, chatId, text })
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

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Polls until the check passes, for things another task does in its own time.
export async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
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
