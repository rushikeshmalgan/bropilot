"use client"

import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { BotMemory, type MemoryListItem } from "@/components/bot-memory"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type BotSettingsProps = {
  bot: { id: string; name: string; job: string; avatar: string }
  memory: {
    files: MemoryListItem[]
    maxFiles: number
    maxFileChars: number
  }
}

// A bot's own page: what it remembers, and (in later tabs) what it runs on.
export function BotSettings({ bot, memory }: BotSettingsProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 max-md:pl-12">
        <BotAvatar name={bot.name} seed={bot.avatar} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <h1 className="truncate text-sm font-medium">{bot.name}</h1>
          <span className="truncate text-xs text-muted-foreground">
            {bot.job}
          </span>
        </div>
        <Link
          href={`/bot/${bot.id}`}
          prefetch={false}
          className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to chat
        </Link>
      </header>

      <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <Tabs defaultValue="memory">
          <TabsList>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <TabsContent value="memory" className="pt-4">
            <BotMemory
              botId={bot.id}
              botName={bot.name}
              files={memory.files}
              maxFiles={memory.maxFiles}
              maxFileChars={memory.maxFileChars}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
