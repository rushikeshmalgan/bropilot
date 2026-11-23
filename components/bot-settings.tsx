"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, Trash2Icon } from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { BotMemory, type MemoryListItem } from "@/components/bot-memory"
import { BotSandbox } from "@/components/bot-sandbox"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { deleteBot } from "@/lib/actions"
import type { SandboxStatus } from "@/lib/sandbox"

type BotSettingsProps = {
  bot: { id: string; name: string; job: string; avatar: string }
  memory: {
    files: MemoryListItem[]
    maxFiles: number
    maxFileChars: number
  }
  sandbox: SandboxStatus
}

// A bot's own page: what it remembers, the computer it can use, and deleting it.
export function BotSettings({ bot, memory, sandbox }: BotSettingsProps) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)

  async function remove() {
    setDeleting(true)
    setProblem(null)
    const result = await deleteBot(bot.id)
    setDeleting(false)

    if ("error" in result) {
      setProblem(result.error)
      setConfirming(false)
      return
    }

    router.push("/")
  }

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
            <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
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
          <TabsContent value="sandbox" className="pt-4">
            <BotSandbox botId={bot.id} botName={bot.name} status={sandbox} />
          </TabsContent>
        </Tabs>

        <div className="mt-8 flex flex-col gap-2 border-t pt-6">
          <span className="text-sm font-medium">Delete {bot.name}</span>
          <p className="text-sm text-muted-foreground">
            This deletes the bot, all of its chats, its memory and its sandbox.
            It can&apos;t be undone.
          </p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete bot
            </Button>
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {bot.name}, every chat with it, its memory and its sandbox will be
              deleted. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={remove}
            >
              {deleting && <Spinner data-icon="inline-start" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
