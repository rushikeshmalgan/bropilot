import { auth } from "@clerk/nextjs/server"
import { cache } from "react"

import { selectActiveRun, sweepChat } from "@/lib/agent/run-store"
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

// Everything the chat page shows: the chat, its messages, and the reply that
// is still being written, if any. Null if the chat isn't the user's.
export async function loadChatPage(chatId: string) {
  const { userId } = await auth.protect()

  const load = () =>
    Promise.all([
      selectChat(userId, chatId),
      selectMessages(userId, chatId),
      selectActiveRun(userId, chatId),
    ])

  let [chat, messages, activeRun] = await load()
  if (!chat) {
    return null
  }

  // Something is unfinished. Usually that's a reply in progress, but it can
  // also be a run that got stuck; tidy the chat first, then read it again so
  // the page never shows a reply that will never arrive.
  if (activeRun || messages.some((message) => message.status === "streaming")) {
    await sweepChat(chat.id)
    ;[chat, messages, activeRun] = await load()
    if (!chat) {
      return null
    }
  }

  return { chat, messages, activeRun }
}
