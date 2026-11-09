// Queries for chats and messages. Every function takes the owner's user ID and
// scopes by it, so a chat that belongs to someone else behaves as if it doesn't
// exist. The Clerk-aware wrappers live in lib/chats.ts and lib/actions.ts.
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/lib/db"
import {
  MAX_GROUP_BOTS,
  MAX_MESSAGE_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/chat-limits"
import {
  bots,
  chatBots,
  chats,
  messages,
  type MessageUsage,
} from "@/lib/db/schema"

export const DEFAULT_CHAT_TITLE = "New chat"
export { MAX_GROUP_BOTS, MAX_MESSAGE_LENGTH, MAX_TITLE_LENGTH }

// Only the most recent messages are loaded; paging can come later.
const MESSAGE_LIMIT = 500

export async function selectChats(userId: string, botId?: string) {
  return db
    .select()
    .from(chats)
    .where(
      and(eq(chats.userId, userId), botId ? eq(chats.botId, botId) : undefined)
    )
    .orderBy(desc(chats.updatedAt))
}

export async function selectGroupChats(userId: string) {
  const groups = await db
    .select()
    .from(chats)
    .where(and(eq(chats.userId, userId), isNull(chats.botId)))
    .orderBy(desc(chats.updatedAt))

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

// Saves a message the user wrote. Returns null if the chat isn't theirs.
export async function insertUserMessage(
  userId: string,
  chatId: string,
  text: string
) {
  const chat = await selectChat(userId, chatId)
  if (!chat) {
    return null
  }

  // A one-on-one chat is named after its first message.
  const retitle = chat.botId !== null && chat.title === DEFAULT_CHAT_TITLE
  const title = retitle ? text.slice(0, MAX_TITLE_LENGTH) : chat.title

  const [[message]] = await db.batch([
    db
      .insert(messages)
      .values({ chatId, role: "user", parts: [{ type: "text", text }] })
      .returning({ id: messages.id, createdAt: messages.createdAt }),
    db
      .update(chats)
      .set({ updatedAt: new Date(), title })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId))),
  ])

  return { id: message.id, createdAt: message.createdAt, retitled: retitle }
}

export async function removeChat(userId: string, chatId: string) {
  const deleted = await db
    .delete(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .returning({ id: chats.id })

  return deleted.length > 0
}

// Saves a bot's reply to a chat the user owns. Returns false if the chat isn't
// theirs. The ID is chosen by the caller so it can match the ID the browser saw
// while the reply streamed in.
export async function insertAssistantMessage(
  userId: string,
  input: {
    id: string
    chatId: string
    botId: string
    text: string
    status: "done" | "error"
    usage?: MessageUsage | null
  }
) {
  const [owned] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, input.chatId), eq(chats.userId, userId)))
    .limit(1)

  if (!owned) {
    return false
  }

  await db.batch([
    db.insert(messages).values({
      id: input.id,
      chatId: input.chatId,
      role: "assistant",
      botId: input.botId,
      parts: [{ type: "text", text: input.text }],
      status: input.status,
      usage: input.usage ?? null,
    }),
    db
      .update(chats)
      .set({ updatedAt: new Date() })
      .where(and(eq(chats.id, input.chatId), eq(chats.userId, userId))),
  ])

  return true
}
