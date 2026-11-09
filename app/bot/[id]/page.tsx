import { auth } from "@clerk/nextjs/server"
import { notFound, redirect } from "next/navigation"

import { getOrCreateChatForBot } from "@/lib/chats"

// Opening a bot lands on its most recent chat, starting one if it has none.
export default async function BotPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await auth.protect()

  const { id } = await params
  const chatId = await getOrCreateChatForBot(id)

  if (!chatId) {
    notFound()
  }

  redirect(`/chat/${chatId}`)
}
