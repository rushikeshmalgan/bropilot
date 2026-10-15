import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { ChatView } from "@/components/chat-view"
import { getBot } from "@/lib/bots"

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await auth.protect()

  const { id } = await params
  const bot = await getBot(id)

  if (!bot) {
    notFound()
  }

  return (
    <AppShell>
      <ChatView bot={{ id: bot.id, name: bot.name, job: bot.job }} />
    </AppShell>
  )
}
