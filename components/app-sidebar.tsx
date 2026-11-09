"use client"

import * as React from "react"
import { Suspense } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Show, UserButton } from "@clerk/nextjs"
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { useBotDialogs } from "@/components/bot-dialogs"
import { toast } from "@/components/ui/toast"
import { createChat } from "@/lib/actions"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"

// The user menu and its placeholder are both this tall.
const USER_MENU_HEIGHT = "h-9"

function UserMenuPlaceholder() {
  return (
    <div
      aria-hidden
      className={`flex items-center gap-2 px-1.5 ${USER_MENU_HEIGHT}`}
    >
      <Skeleton className="size-7 shrink-0 rounded-full" />
      <Skeleton className="h-3 w-24 group-data-[collapsible=icon]:hidden" />
    </div>
  )
}

export function AppSidebar() {
  const { bots, groups, openNewBot, openNewGroup } = useBotDialogs()
  const pathname = usePathname()
  const router = useRouter()
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [startingChat, startChat] = React.useTransition()

  // The chat that's open, if any, and the bot it belongs to.
  const currentChatId = pathname.startsWith("/chat/")
    ? pathname.split("/")[2]
    : null
  const activeBotId =
    bots.find((bot) => bot.chats.some((chat) => chat.id === currentChatId))
      ?.id ?? null

  function newChat(botId: string) {
    startChat(async () => {
      const result = await createChat(botId)

      if ("error" in result) {
        toast.add({ title: "Couldn't start a chat", description: result.error })
        return
      }

      router.push(`/chat/${result.id}`)
    })
  }

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key?.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-2 px-2 pt-1 pb-0 group-data-[collapsible=icon]:pt-2">
        <div className="flex justify-end group-data-[collapsible=icon]:justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Create new"
                  className="group-data-[collapsible=icon]:size-12"
                />
              }
            >
              <PlusIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={openNewBot}>
                  <PlusIcon />
                  Create new bot
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openNewGroup}>
                  <UsersIcon />
                  Create group chat
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Button
          variant="outline"
          className="h-8 w-full justify-start gap-2 bg-input/30 px-2.5 font-normal text-muted-foreground group-data-[collapsible=icon]:hidden"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
          Search
          <span className="ml-auto text-xs">⌘K</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search"
          className="hidden size-12 group-data-[collapsible=icon]:flex"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-2 pt-4">
          <SidebarMenu className="gap-1.5">
            {bots.map((bot) => (
              <SidebarMenuItem key={bot.id}>
                <SidebarMenuButton
                  // Opening a bot starts a chat if it has none, so don't prefetch.
                  render={<Link href={`/bot/${bot.id}`} prefetch={false} />}
                  isActive={bot.id === activeBotId}
                  tooltip={bot.name}
                  className="h-auto gap-3 px-3 py-1.5 group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                >
                  <BotAvatar
                    name={bot.name}
                    seed={bot.avatar}
                    className="size-5.5"
                  />
                  <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {bot.name}
                      </span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">
                        {bot.ago}
                      </span>
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {bot.job}
                    </span>
                  </div>
                </SidebarMenuButton>
                {bot.id === activeBotId && (
                  <SidebarMenuSub>
                    {bot.chats.slice(0, 5).map((chat) => (
                      <SidebarMenuSubItem key={chat.id}>
                        <SidebarMenuSubButton
                          render={<Link href={`/chat/${chat.id}`} />}
                          isActive={chat.id === currentChatId}
                        >
                          <span>{chat.title}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        aria-disabled={startingChat}
                        onClick={() => newChat(bot.id)}
                      >
                        <PlusIcon />
                        <span>New chat</span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            ))}
            {groups.map((group) => (
              <SidebarMenuItem key={group.id}>
                <SidebarMenuButton
                  render={<Link href={`/chat/${group.id}`} />}
                  isActive={group.id === currentChatId}
                  tooltip={group.title}
                  className="h-auto gap-3 px-3 py-1.5 group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                >
                  <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <UsersIcon className="size-3" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {group.title}
                      </span>
                      <span className="shrink-0 text-xs font-normal text-muted-foreground">
                        {group.ago}
                      </span>
                    </div>
                    <span className="truncate text-xs text-muted-foreground">
                      {group.botNames.join(", ")}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 py-3">
        {/* Clerk renders the user menu only once it has loaded, which can be
            before or after React hydrates. Showing it inside Show and
            Suspense, as Clerk's docs do, keeps the server and browser markup
            the same. */}
        <Suspense fallback={<UserMenuPlaceholder />}>
          <Show when="signed-in">
            <UserButton
              showName
              appearance={{
                elements: {
                  userButtonBox: "flex-row-reverse gap-2",
                  // The same height as the placeholder, so nothing shifts.
                  userButtonTrigger: USER_MENU_HEIGHT,
                  userButtonOuterIdentifier:
                    "text-sm font-normal text-sidebar-foreground group-data-[collapsible=icon]:hidden",
                },
              }}
            />
          </Show>
        </Suspense>
      </SidebarFooter>
      <SidebarRail />

      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search bots"
        description="Find a bot and jump to its chat."
      >
        <CommandInput placeholder="Search bots..." />
        <CommandList>
          <CommandEmpty>No bots found.</CommandEmpty>
          <CommandGroup heading="Bots">
            {bots.map((bot) => (
              <CommandItem
                key={bot.id}
                value={`${bot.name} ${bot.job}`}
                onSelect={() => {
                  setSearchOpen(false)
                  router.push(`/bot/${bot.id}`)
                }}
              >
                <BotAvatar name={bot.name} seed={bot.avatar} size="sm" />
                {bot.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </Sidebar>
  )
}
