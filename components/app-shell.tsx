import { auth } from "@clerk/nextjs/server"
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
import { getPlan } from "@/lib/billing"
import { listBots } from "@/lib/bots"
import { listChats, listGroupChats } from "@/lib/chats"
import { activeBotIds, getUsageSummary, type UsageSummary } from "@/lib/usage"

function formatAgo(date: Date) {
  if (Date.now() - date.getTime() < 60_000) {
    return "now"
  }

  return formatDistanceToNowStrict(date)
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const { userId } = await auth.protect()
  const plan = await getPlan(userId)
  const [bots, chats, groups, cookieStore, usage, active] = await Promise.all([
    listBots(),
    listChats(),
    listGroupChats(),
    cookies(),
    getUsageSummary(userId, plan),
    activeBotIds(userId, plan),
  ])

  return (
    <AppShellFrame
      usage={usage}
      bots={bots.map((bot) => {
        const botChats = chats.filter((chat) => chat.botId === bot.id)

        return {
          id: bot.id,
          name: bot.name,
          job: bot.job,
          avatar: bot.avatar,
          // Past what the plan covers: kept, but read-only.
          readOnly: !active.includes(bot.id),
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
  usage = null,
  defaultOpen,
  children,
}: {
  bots: SidebarBot[]
  groups: SidebarGroup[]
  usage?: UsageSummary | null
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <BotDialogsProvider bots={bots} groups={groups} usage={usage}>
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
