import { auth } from "@clerk/nextjs/server"
import { notFound } from "next/navigation"

import { AppShell } from "@/components/app-shell"
import { BotSettings } from "@/components/bot-settings"
import { getBot } from "@/lib/bots"
import { MEMORY_LIMITS, listMemory } from "@/lib/memory"

// A bot's own page. Someone else's bot is a 404, the same as one that doesn't
// exist.
export default async function BotSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { userId } = await auth.protect()

  const { id } = await params
  const [bot, files] = await Promise.all([getBot(id), listMemory(userId, id)])
  if (!bot || !files) {
    notFound()
  }

  return (
    <AppShell>
      <BotSettings
        bot={{ id: bot.id, name: bot.name, job: bot.job, avatar: bot.avatar }}
        memory={{
          files: files.map((file) => ({
            path: file.path,
            version: file.version,
            size: file.size,
          })),
          maxFiles: MEMORY_LIMITS.maxFiles,
          maxFileChars: MEMORY_LIMITS.maxFileChars,
        }}
      />
    </AppShell>
  )
}
