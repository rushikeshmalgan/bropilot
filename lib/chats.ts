import { auth } from "@clerk/nextjs/server"
import { cache } from "react"

import {
  insertChat,
  selectBot,
  selectChat,
  selectChats,
  selectGroupChats,
  selectLatestChatForBot,
  selectMessages,
} from "@/lib/chat-store"

// All of these act for the signed-in user and are cached per request.

// The user's chats, most recently active first; pass a bot ID to limit it to
// that bot's one-on-one chats.
export const listChats = cache(async (botId?: string) => {
  const { userId } = await auth.protect()
  return selectChats(userId, botId)
})

export const listGroupChats = cache(async () => {
  const { userId } = await auth.protect()
  return selectGroupChats(userId)
})

// A chat with its bots, or null if it doesn't exist or isn't the user's.
export const getChat = cache(async (chatId: string) => {
  const { userId } = await auth.protect()
  return selectChat(userId, chatId)
})

export const getMessages = cache(async (chatId: string) => {
  const { userId } = await auth.protect()
  return selectMessages(userId, chatId)
})

// The ID of a chat to open for a bot: the most recent one, or a new one if the
// bot has none yet. Null if the bot isn't the user's. Not cached, since it can
// write.
export async function getOrCreateChatForBot(botId: string) {
  const { userId } = await auth.protect()

  if (!(await selectBot(userId, botId))) {
    return null
  }

  const latest = await selectLatestChatForBot(userId, botId)
  return latest?.id ?? insertChat(userId, { botIds: [botId] })
}
