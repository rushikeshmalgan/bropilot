"use client"

import * as React from "react"
import {
  MonitorIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type ScreenState = "stopped" | "starting" | "live" | "error" | "deleting"

// What /api/bots/[id]/screen answers. It never names the sandbox.
type ScreenReply =
  | { configured: false }
  | {
      configured: true
      state: ScreenState
      reason?: "no_sandbox" | "unreachable" | "failed"
      url?: string
      expiresInSeconds?: number
    }

// How often the panel asks for the state while it is open.
const POLL_MS = 5000

async function askScreen(
  botId: string,
  method: "GET" | "POST",
  body?: { start?: boolean; control?: boolean }
): Promise<ScreenReply> {
  const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/screen`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`Screen request failed (${response.status})`)
  }
  return (await response.json()) as ScreenReply
}

type ScreenViewerProps = {
  botId: string
  botName: string
  // The bot is using the screen in the reply that is being written now.
  usingScreen: boolean
  // There is a reply to stop.
  canStop: boolean
  stopping: boolean
  onStop: () => void
}

// The bot's screen, beside the chat: what state it is in, the live picture,
// and the owner's controls. See docs/computer-use.md.
export function ScreenViewer({
  botId,
  botName,
  usingScreen,
  canStop,
  stopping,
  onStop,
}: ScreenViewerProps) {
  const [reply, setReply] = React.useState<ScreenReply | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [control, setControl] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  // The newest values, for the timer and for callbacks that outlive a render.
  const latest = React.useRef({ control, busy })
  React.useEffect(() => {
    latest.current = { control, busy }
  })

  // Asks for a fresh address. Every call makes a new one, so this only runs
  // when the panel opens, the owner reloads, or control is switched.
  const connect = React.useCallback(
    async (wantControl: boolean, start = false) => {
      setBusy(true)
      setFailed(false)
      try {
        const next = await askScreen(botId, "POST", {
          start,
          control: wantControl,
        })
        setReply(next)
        setUrl(next.configured && next.state === "live" ? (next.url ?? null) : null)
      } catch {
        setFailed(true)
      } finally {
        setBusy(false)
      }
    },
    [botId]
  )

  // Opening the panel connects once, then the state is checked now and then.
  React.useEffect(() => {
    let cancelled = false

    // Started on the next tick, not inside the effect itself.
    const first = setTimeout(() => void connect(false), 0)

    const timer = setInterval(async () => {
      if (latest.current.busy) {
        return
      }
      try {
        const next = await askScreen(botId, "GET")
        if (cancelled) {
          return
        }
        setReply(next)
        setFailed(false)
        if (next.configured && next.state !== "live") {
          setUrl(null)
        }
      } catch {
        if (!cancelled) {
          setFailed(true)
        }
      }
    }, POLL_MS)

    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [botId, connect])

  // It came up (or came back) without us asking: connect to it.
  const state = reply?.configured ? reply.state : null
  React.useEffect(() => {
    if (state !== "live" || url) {
      return
    }

    const timer = setTimeout(() => {
      if (!latest.current.busy) {
        void connect(latest.current.control)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [state, url, connect])

  // The owner and the bot shouldn't fight over the mouse: while the bot is
  // using the screen the view is view-only.
  React.useEffect(() => {
    if (!usingScreen) {
      return
    }

    const timer = setTimeout(() => {
      if (latest.current.control) {
        setControl(false)
        void connect(false)
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [usingScreen, connect])

  function toggleControl() {
    const next = !control
    setControl(next)
    void connect(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <span className="truncate text-xs text-muted-foreground">
          {botName}&apos;s screen
        </span>
        <div className="flex items-center gap-1">
          {canStop && (
            <Button
              variant="outline"
              size="xs"
              disabled={stopping}
              onClick={onStop}
            >
              <SquareIcon data-icon="inline-start" />
              Stop
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload the screen"
            disabled={busy}
            onClick={() => void connect(control)}
          >
            <RefreshCwIcon className={cn(busy && "animate-spin")} />
          </Button>
        </div>
      </div>

      {usingScreen && (
        <p
          role="status"
          className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/50" />
            <span className="relative inline-flex size-2 rounded-full bg-foreground" />
          </span>
          {botName} is using the screen
        </p>
      )}

      <div className="mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-muted/40">
        {reply === null && !failed ? (
          <Message icon={<Spinner />} title="Connecting…" />
        ) : failed && !reply ? (
          <Message
            icon={<TriangleAlertIcon className="text-destructive" />}
            title="Couldn't reach the screen"
            action={
              <Button variant="outline" size="sm" onClick={() => void connect(control)}>
                Try again
              </Button>
            }
          />
        ) : reply && !reply.configured ? (
          <Message
            icon={<MonitorIcon className="text-muted-foreground" />}
            title="Screens aren't set up"
            text="This server isn't connected to a sandbox service yet, so bots have no screen."
          />
        ) : reply && reply.configured && reply.state === "live" && url ? (
          <iframe
            key={url}
            src={url}
            title={`${botName}'s screen`}
            className="min-h-0 flex-1 border-0 bg-black"
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            referrerPolicy="no-referrer"
          />
        ) : reply && reply.configured && reply.state === "live" ? (
          <Message icon={<Spinner />} title="Opening the screen…" />
        ) : reply && reply.configured && reply.state === "starting" ? (
          <Message
            icon={<Spinner />}
            title="Starting"
            text="The screen is being set up. This takes a few seconds."
          />
        ) : reply && reply.configured && reply.state === "deleting" ? (
          <Message
            icon={<Spinner />}
            title="Being removed"
            text="The sandbox is being deleted."
          />
        ) : reply && reply.configured && reply.state === "error" ? (
          <Message
            icon={<TriangleAlertIcon className="text-destructive" />}
            title={
              reply.reason === "unreachable"
                ? "Can't reach the sandbox service"
                : "The screen isn't working"
            }
            text={
              reply.reason === "unreachable"
                ? "It didn't answer. Try again in a moment."
                : `Open ${botName}'s settings and reset its sandbox to start fresh.`
            }
            action={
              <Button variant="outline" size="sm" onClick={() => void connect(control)}>
                Try again
              </Button>
            }
          />
        ) : reply && reply.configured && reply.reason === "no_sandbox" ? (
          <Message
            icon={<MonitorIcon className="text-muted-foreground" />}
            title="Nothing to show yet"
            text={`${botName} gets a computer the first time it needs one. Ask it to do something that needs a screen and it will appear here.`}
          />
        ) : (
          <Message
            icon={<MonitorIcon className="text-muted-foreground" />}
            title="The screen is off"
            text="It switched itself off after a while. Starting it brings back everything on it."
            action={
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void connect(control, true)}
              >
                {busy ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <PlayIcon data-icon="inline-start" />
                )}
                Start the screen
              </Button>
            }
          />
        )}
      </div>

      {reply && reply.configured && reply.state === "live" && (
        <div className="mx-3 mb-3 flex items-center justify-between gap-2 text-xs">
          <label
            className={cn(
              "flex items-center gap-2",
              usingScreen && "text-muted-foreground"
            )}
          >
            <input
              type="checkbox"
              checked={control}
              disabled={usingScreen || busy}
              onChange={toggleControl}
              className="size-3.5 accent-foreground"
            />
            Take control
          </label>
          <span className="text-muted-foreground">
            {usingScreen
              ? "Stop the reply to take control."
              : control
                ? "You can click and type."
                : "View only."}
          </span>
        </div>
      )}
    </div>
  )
}

function Message({
  icon,
  title,
  text,
  action,
}: {
  icon: React.ReactNode
  title: string
  text?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="[&_svg]:size-6">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {text && <p className="text-xs text-muted-foreground">{text}</p>}
      {action}
    </div>
  )
}
