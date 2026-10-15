"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { UserButton } from "@clerk/nextjs"
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { useBotDialogs } from "@/components/bot-dialogs"
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  const { bots, openNewBot, openNewGroup } = useBotDialogs()
  const pathname = usePathname()
  const router = useRouter()
  const [searchOpen, setSearchOpen] = React.useState(false)

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
                  render={<Link href={`/chat/${bot.id}`} />}
                  isActive={pathname === `/chat/${bot.id}`}
                  tooltip={bot.name}
                  className="h-auto gap-3 px-3 py-1.5 group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                >
                  <BotAvatar name={bot.name} className="size-5.5" />
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
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 py-3">
        <UserButton
          showName
          appearance={{
            elements: {
              userButtonBox: "flex-row-reverse gap-2",
              userButtonOuterIdentifier:
                "text-sm font-normal text-sidebar-foreground group-data-[collapsible=icon]:hidden",
            },
          }}
        />
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
                  router.push(`/chat/${bot.id}`)
                }}
              >
                <BotAvatar name={bot.name} size="sm" />
                {bot.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </Sidebar>
  )
}
