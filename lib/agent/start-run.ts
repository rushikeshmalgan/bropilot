// Accepts a message from the user and starts the bot's reply as a background
// run. Nothing here talks to the model; that happens in executeRun.
import { and, desc, eq, isNotNull } from "drizzle-orm"
import { nanoid } from "nanoid"

import {
  CHAT_BUSY_MESSAGE,
  ENQUEUE_FAILED_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  RATE_LIMITED_MESSAGE,
} from "@/lib/ai"
import { pickBot } from "@/lib/agent/run-model"
import { failRun, sweepChat } from "@/lib/agent/run-store"
import {
  DEFAULT_CHAT_TITLE,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
  selectChat,
} from "@/lib/chat-store"
import type { RunHandle } from "@/lib/chat-types"
import { db } from "@/lib/db"
import { chats, messages, runs } from "@/lib/db/schema"
import {
  READ_ONLY_BOT_MESSAGE,
  runLimitRefusal,
  tokenLimitRefusal,
  type PlanId,
} from "@/lib/plans"
import { getRunQueue } from "@/lib/providers"
import type { RunQueue } from "@/lib/providers/run-queue"
import { checkRateLimit } from "@/lib/rate-limit"
import { activeBotIds, releaseRun, reserveRun } from "@/lib/usage"

export type StartRunResult =
  | { ok: true; run: RunHandle; userMessageId: string }
  | {
      ok: false
      status: number
      code: string
      error: string
      retryAfterSeconds?: number
      // The refusal is a plan limit, so the screen can offer an upgrade.
      upgrade?: boolean
    }

function refuse(
  status: number,
  code: string,
  error: string,
  retryAfterSeconds?: number,
  upgrade?: boolean
): StartRunResult {
  return { ok: false, status, code, error, retryAfterSeconds, upgrade }
}

// Postgres reports a broken unique index with this code. The driver may wrap
// the error, so look inside it too.
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) {
    return false
  }

  const record = error as Record<string, unknown>
  return record.code === "23505" || isUniqueViolation(record.cause, depth + 1)
}

// A read token for the browser, or null. Live updates are optional, so a
// failure here just means the browser polls.
export async function liveAccess(
  queue: RunQueue | null,
  externalId: string | null
): Promise<RunHandle["live"]> {
  if (!queue || !externalId) {
    return null
  }

  try {
    const token = await queue.createReadToken(externalId)
    return token ? { externalId, token } : null
  } catch {
    return null
  }
}

// The caller has already checked who the user is.
export async function startRun({
  userId,
  chatId,
  text: rawText,
  plan,
}: {
  userId: string
  chatId: string
  text: string
  // The user's plan, read from their session by the caller.
  plan: PlanId
}): Promise<StartRunResult> {
  const text = rawText.trim()
  if (!text) {
    return refuse(400, "empty_message", "Write a message first.")
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return refuse(
      400,
      "message_too_long",
      `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`
    )
  }

  const queue = getRunQueue()
  if (!queue) {
    return refuse(503, "not_configured", NOT_CONFIGURED_MESSAGE)
  }

  const limit = checkRateLimit(userId)
  if (!limit.ok) {
    return refuse(
      429,
      "rate_limited",
      RATE_LIMITED_MESSAGE,
      limit.retryAfterSeconds
    )
  }

  // A chat that isn't the user's is the same as one that doesn't exist.
  const chat = await selectChat(userId, chatId)
  if (!chat || chat.bots.length === 0) {
    return refuse(404, "not_found", "That chat doesn't exist.")
  }

  // Only a group chat needs to know who spoke last.
  const lastSpeaker =
    chat.bots.length > 1
      ? await db
          .select({ role: messages.role, botId: messages.botId })
          .from(messages)
          .where(
            and(
              eq(messages.chatId, chatId),
              eq(messages.role, "assistant"),
              isNotNull(messages.botId)
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(1)
      : []
  const bot = pickBot(chat.bots, text, lastSpeaker)

  // A plan covers a number of bots. The rest are kept but can't be used.
  if (!(await activeBotIds(userId, plan)).includes(bot.id)) {
    return refuse(403, "bot_read_only", READ_ONLY_BOT_MESSAGE)
  }

  // Take this reply from the month's allowance. The check and the count are
  // one step, so replies started at the same moment can't pass the limit.
  const reservation = await reserveRun(userId, plan)
  if (!reservation.ok) {
    const refusal =
      reservation.reason === "runs"
        ? runLimitRefusal(plan)
        : tokenLimitRefusal(plan)
    return refuse(402, refusal.code, refusal.error, undefined, refusal.upgrade)
  }
  // Given back if the reply turns out not to start.
  const giveBack = () => releaseRun(userId, reservation.month).catch(() => {})

  const runId = nanoid()
  const userMessageId = nanoid()
  const assistantMessageId = nanoid()
  // A one-on-one chat is named after its first message.
  const retitle = chat.botId !== null && chat.title === DEFAULT_CHAT_TITLE
  const title = retitle ? text.slice(0, MAX_TITLE_LENGTH) : chat.title

  // The message and its run are saved together or not at all. The database
  // allows one unfinished run per chat, so a second send at the same moment
  // fails here and saves nothing.
  const save = () =>
    db.batch([
      db.insert(messages).values({
        id: userMessageId,
        chatId,
        role: "user",
        parts: [{ type: "text", text }],
      }),
      db.insert(runs).values({
        id: runId,
        chatId,
        botId: bot.id,
        userMessageId,
        assistantMessageId,
        plan,
      }),
      db
        .update(chats)
        .set({ updatedAt: new Date(), title })
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId))),
    ])

  try {
    await save()
  } catch (error) {
    if (!isUniqueViolation(error)) {
      await giveBack()
      throw error
    }

    // Another run is unfinished. If it's a stuck one, clear it and try once
    // more; if it's really running, the user has to wait or stop it.
    await sweepChat(chatId)
    try {
      await save()
    } catch (again) {
      await giveBack()
      if (!isUniqueViolation(again)) {
        throw again
      }
      return refuse(409, "chat_busy", CHAT_BUSY_MESSAGE)
    }
  }

  const handle: RunHandle = {
    runId,
    assistantMessageId,
    botId: bot.id,
    live: null,
  }

  try {
    const { externalId } = await queue.enqueue(runId)
    const [, live] = await Promise.all([
      db
        .update(runs)
        .set({ triggerRunId: externalId })
        .where(eq(runs.id, runId)),
      liveAccess(queue, externalId),
    ])
    handle.live = live
  } catch (error) {
    // The message is saved, so the chat shows it with an error underneath.
    console.error(
      `Couldn't queue run ${runId}:`,
      error instanceof Error ? error.message : error
    )
    await failRun(
      { id: runId, chatId, botId: bot.id, assistantMessageId },
      ENQUEUE_FAILED_MESSAGE,
      ["queued"]
    )
    // Our own failure isn't taken out of the user's allowance.
    await giveBack()
  }

  return { ok: true, run: handle, userMessageId }
}
