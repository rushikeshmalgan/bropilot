import { auth } from "@clerk/nextjs/server"

import { AppShell } from "@/components/app-shell"
import { BotEmpty } from "@/components/bot-empty"

export default async function Page() {
  await auth.protect()

  return (
    <AppShell>
      <BotEmpty />
    </AppShell>
  )
}
