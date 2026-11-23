import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { ChatView } from "@/components/chat-view"
import { getPlan } from "@/lib/billing"
import type { ChatMessage } from "@/lib/chat-types"
import { loadChatPage } from "@/lib/chats"
import { activeBotIds } from "@/lib/usage"

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { userId } = await auth.protect()

  const { id } = await params

  // A chat that belongs to someone else is a 404, the same as one that doesn't
  // exist, so URLs can't be used to find out what exists.
  const page = await loadChatPage(id)
  if (!page) {
    notFound()
  }

  const { chat, messages, activeRun } = page

  // The plan covers a number of bots; the rest can be read but not used. A
  // group chat is read-only only if none of its bots can be used.
  const active = await activeBotIds(userId, await getPlan(userId))
  const readOnly =
    chat.bots.length > 0 && chat.bots.every((bot) => !active.includes(bot.id))

  return (
    <AppShell>
      <ChatView
        // A new key resets the draft and messages when switching chats.
        key={chat.id}
        chat={{ id: chat.id, title: chat.title, isGroup: chat.botId === null }}
        bots={chat.bots}
        initialMessages={messages.map(
          (message): ChatMessage => ({
            id: message.id,
            role: message.role,
            botId: message.botId,
            parts: message.parts,
            status: message.status,
          })
        )}
        // The screen reattaches to a reply that is still being written.
        activeRunId={activeRun?.id ?? null}
        readOnly={readOnly}
      />
    </AppShell>
  )
}
