// Queries for chats and messages. Every function takes the owner's user ID and
// scopes by it, so a chat that belongs to someone else behaves as if it doesn't
// exist. The Clerk-aware wrappers live in lib/chats.ts and lib/actions.ts.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/lib/db"
import {
  MAX_GROUP_BOTS,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/chat-limits"
import { bots, chatBots, chats, messages } from "@/lib/db/schema"

export const DEFAULT_CHAT_TITLE = "New chat"
export { MAX_GROUP_BOTS, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH }

// Only the most recent messages are loaded; paging can come later.
const MESSAGE_LIMIT = 500

// Chats one user may have, and how many are listed at once. The sidebar loads
// the lists on every page, so they are bounded.
export const MAX_CHATS_PER_USER = 500
const CHAT_LIST_LIMIT = 300
const GROUP_LIST_LIMIT = 100

export async function countChats(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chats)
    .where(eq(chats.userId, userId))
  return row?.count ?? 0
}

export async function selectChats(userId: string, botId?: string) {
  return db
    .select()
    .from(chats)
    .where(
      and(eq(chats.userId, userId), botId ? eq(chats.botId, botId) : undefined)
    )
    .orderBy(desc(chats.updatedAt))
    .limit(CHAT_LIST_LIMIT)
}

export async function selectGroupChats(userId: string) {
  const groups = await db
    .select()
    .from(chats)
    .where(and(eq(chats.userId, userId), isNull(chats.botId)))
    .orderBy(desc(chats.updatedAt))
    .limit(GROUP_LIST_LIMIT)

  return withParticipants(groups)
}

async function withParticipants<T extends { id: string }>(rows: T[]) {
  if (rows.length === 0) {
    return []
  }

  const participants = await db
    .select({
      chatId: chatBots.chatId,
      id: bots.id,
      name: bots.name,
      job: bots.job,
      avatar: bots.avatar,
    })
    .from(chatBots)
    .innerJoin(bots, eq(bots.id, chatBots.botId))
    .where(
      inArray(
        chatBots.chatId,
        rows.map((row) => row.id)
      )
    )

  return rows.map((row) => ({
    ...row,
    bots: participants
      .filter((participant) => participant.chatId === row.id)
      .map(({ id, name, job, avatar }) => ({ id, name, job, avatar })),
  }))
}

export async function selectChat(userId: string, chatId: string) {
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1)

  if (!chat) {
    return null
  }

  const [withBots] = await withParticipants([chat])
  return withBots
}

export async function selectLatestChatForBot(userId: string, botId: string) {
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.userId, userId), eq(chats.botId, botId)))
    .orderBy(desc(chats.updatedAt))
    .limit(1)

  return chat ?? null
}

export async function selectBot(userId: string, botId: string) {
  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1)

  return bot ?? null
}

// The oldest-first transcript of a chat the user owns, or [] if it isn't theirs.
export async function selectMessages(userId: string, chatId: string) {
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(eq(messages.chatId, chatId), eq(chats.userId, userId)))
    .orderBy(desc(messages.createdAt))
    .limit(MESSAGE_LIMIT)

  return rows.map((row) => row.message).reverse()
}

// Creates a chat with the given bots. Returns null if any bot is missing or
// belongs to someone else. A group chat has no single bot of its own.
export async function insertChat(
  userId: string,
  input: { botIds: string[]; title?: string; group?: boolean }
) {
  const botIds = [...new Set(input.botIds)]
  if (botIds.length === 0 || botIds.length > MAX_GROUP_BOTS) {
    return null
  }

  const owned = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.userId, userId), inArray(bots.id, botIds)))

  if (owned.length !== botIds.length) {
    return null
  }

  const id = nanoid()
  const isGroup = input.group === true

  // One request, one transaction: the chat and its participants appear together.
  await db.batch([
    db.insert(chats).values({
      id,
      userId,
      botId: isGroup ? null : botIds[0],
      title: input.title ?? DEFAULT_CHAT_TITLE,
    }),
    db.insert(chatBots).values(botIds.map((botId) => ({ chatId: id, botId }))),
  ])

  return id
}

export async function removeChat(userId: string, chatId: string) {
  const deleted = await db
    .delete(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .returning({ id: chats.id })

  return deleted.length > 0
}
