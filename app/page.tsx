import { auth } from "@clerk/nextjs/server"

import { AppShell } from "@/components/app-shell"
import { BotEmpty } from "@/components/bot-empty"
import { BotPicker } from "@/components/bot-picker"
import { listBots } from "@/lib/bots"

export default async function Page() {
  await auth.protect()

  // No bots yet: make one. Some bots: open one.
  const [newest] = await listBots()

  return (
    <AppShell>
      {newest ? (
        <BotPicker
          bot={{
            id: newest.id,
            name: newest.name,
            job: newest.job,
            avatar: newest.avatar,
          }}
        />
      ) : (
        <BotEmpty />
      )}
    </AppShell>
  )
}
