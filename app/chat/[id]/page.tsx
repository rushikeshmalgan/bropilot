import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { ChatView } from "@/components/chat-view"
import type { ChatUIMessage } from "@/lib/chat-types"
import { getChat, getMessages } from "@/lib/chats"

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await auth.protect()

  const { id } = await params

  // A chat that belongs to someone else is a 404, the same as one that doesn't
  // exist, so URLs can't be used to find out what exists.
  const [chat, messages] = await Promise.all([getChat(id), getMessages(id)])
  if (!chat) {
    notFound()
  }

  return (
    <AppShell>
      <ChatView
        // A new key resets the draft and messages when switching chats.
        key={chat.id}
        chat={{ id: chat.id, title: chat.title, isGroup: chat.botId === null }}
        bots={chat.bots}
        initialMessages={messages.map(
          (message): ChatUIMessage => ({
            id: message.id,
            role: message.role,
            parts: message.parts,
            metadata: {
              botId: message.botId,
              botName: chat.bots.find((bot) => bot.id === message.botId)?.name,
              status: message.status === "error" ? "error" : "done",
            },
          })
        )}
      />
    </AppShell>
  )
}
