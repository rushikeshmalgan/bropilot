import { formatDistanceToNowStrict } from "date-fns"
import { cookies } from "next/headers"

import { AppSidebar } from "@/components/app-sidebar"
import { BotDialogsProvider, type SidebarBot } from "@/components/bot-dialogs"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { listBots } from "@/lib/bots"

function formatAgo(date: Date) {
  if (Date.now() - date.getTime() < 60_000) {
    return "now"
  }

  return formatDistanceToNowStrict(date)
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const [bots, cookieStore] = await Promise.all([listBots(), cookies()])

  return (
    <AppShellFrame
      bots={bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        job: bot.job,
        ago: formatAgo(bot.createdAt),
      }))}
      defaultOpen={cookieStore.get("sidebar_state")?.value !== "false"}
    >
      {children}
    </AppShellFrame>
  )
}

// The layout itself, without any data fetching, so it can be rendered with
// fixed bots.
export function AppShellFrame({
  bots,
  defaultOpen,
  children,
}: {
  bots: SidebarBot[]
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <BotDialogsProvider bots={bots}>
      <SidebarProvider
        defaultOpen={defaultOpen}
        style={{ "--sidebar-width-icon": "4rem" } as React.CSSProperties}
      >
        <AppSidebar />
        <SidebarInset className="h-svh min-w-0 overflow-hidden">
          <SidebarTrigger className="absolute top-1.5 left-2 z-10 md:hidden" />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </BotDialogsProvider>
  )
}
