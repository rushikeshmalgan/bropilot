"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { MonitorIcon, RotateCcwIcon } from "lucide-react"

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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { resetSandbox } from "@/lib/actions"
import type { SandboxStatus } from "@/lib/sandbox"

const STATE_TEXT: Record<
  Extract<SandboxStatus, { configured: true }>["state"],
  { label: string; detail: string }
> = {
  none: {
    label: "Not created yet",
    detail:
      "The sandbox is made the first time this bot needs to run something. Nothing is running now.",
  },
  running: {
    label: "Running",
    detail: "The bot's sandbox is on and ready for commands.",
  },
  stopped: {
    label: "Stopped",
    detail:
      "It switched itself off after a while without use. It starts again, with its files, the next time the bot needs it.",
  },
  starting: {
    label: "Starting",
    detail: "The sandbox is being set up or woken. This takes a few seconds.",
  },
  deleting: {
    label: "Being removed",
    detail:
      "The sandbox is being deleted. A fresh one is made the next time it is needed.",
  },
  error: {
    label: "Needs a reset",
    detail:
      "The sandbox is in an error state and can't run commands. Resetting it makes a fresh one.",
  },
  unknown: {
    label: "Can't check right now",
    detail:
      "The sandbox service didn't answer. The bot may still be able to use its sandbox.",
  },
}

// The Sandbox tab: whether the bot has a sandbox, and a way to start over.
export function BotSandbox({
  botId,
  botName,
  status,
}: {
  botId: string
  botName: string
  status: SandboxStatus
}) {
  const router = useRouter()
  const [confirming, setConfirming] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)

  async function reset() {
    setResetting(true)
    setProblem(null)
    const result = await resetSandbox(botId)
    setResetting(false)

    if ("error" in result) {
      setProblem(result.error)
      setConfirming(false)
      return
    }

    setConfirming(false)
    router.refresh()
  }

  if (!status.configured) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia>
            <MonitorIcon className="size-6 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Sandboxes aren&apos;t set up</EmptyTitle>
          <EmptyDescription>
            A sandbox is a small computer {botName} can run commands and keep
            files on. This server doesn&apos;t have one connected yet: the
            sandbox service&apos;s API key needs to be added to its
            configuration.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const text = STATE_TEXT[status.state]

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-lg border p-4">
        <span className="text-xs text-muted-foreground">Status</span>
        <span className="text-sm font-medium">{text.label}</span>
        <p className="text-sm text-muted-foreground">{text.detail}</p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-4">
        <span className="text-sm font-medium">Reset the sandbox</span>
        <p className="text-sm text-muted-foreground">
          This deletes the sandbox and everything {botName} saved in it. The
          next time it needs one, it gets a new empty sandbox. Its memory and
          chats are not affected.
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={status.state === "none" || resetting}
            onClick={() => setConfirming(true)}
          >
            <RotateCcwIcon data-icon="inline-start" />
            Reset sandbox
          </Button>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this sandbox?</AlertDialogTitle>
            <AlertDialogDescription>
              Every file {botName} saved in its sandbox will be deleted. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={resetting} onClick={reset}>
              {resetting && <Spinner data-icon="inline-start" />}
              Reset
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
