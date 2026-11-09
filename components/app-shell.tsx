import { formatDistanceToNowStrict } from "date-fns"
import { cookies } from "next/headers"

import { AppSidebar } from "@/components/app-sidebar"
import {
  BotDialogsProvider,
  type SidebarBot,
  type SidebarGroup,
} from "@/components/bot-dialogs"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { listBots } from "@/lib/bots"
import { listChats, listGroupChats } from "@/lib/chats"

function formatAgo(date: Date) {
  if (Date.now() - date.getTime() < 60_000) {
    return "now"
  }

  return formatDistanceToNowStrict(date)
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const [bots, chats, groups, cookieStore] = await Promise.all([
    listBots(),
    listChats(),
    listGroupChats(),
    cookies(),
  ])

  return (
    <AppShellFrame
      bots={bots.map((bot) => {
        const botChats = chats.filter((chat) => chat.botId === bot.id)

        return {
          id: bot.id,
          name: bot.name,
          job: bot.job,
          avatar: bot.avatar,
          // The sidebar shows when the bot was last talked to.
          ago: formatAgo(botChats[0]?.updatedAt ?? bot.createdAt),
          chats: botChats.map((chat) => ({ id: chat.id, title: chat.title })),
        }
      })}
      groups={groups.map((group) => ({
        id: group.id,
        title: group.title,
        ago: formatAgo(group.updatedAt),
        botNames: group.bots.map((bot) => bot.name),
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
  groups,
  defaultOpen,
  children,
}: {
  bots: SidebarBot[]
  groups: SidebarGroup[]
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <BotDialogsProvider bots={bots} groups={groups}>
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
