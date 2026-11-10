"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { BotAvatar } from "@/components/bot-avatar"
import { RunFollower } from "@/components/run-follower"
import { ToolCard } from "@/components/tool-card"
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
import { toast } from "@/components/ui/toast"
import { attachRun, deleteChat, stopRun } from "@/lib/actions"
import { MAX_MESSAGE_LENGTH } from "@/lib/chat-limits"
import {
  applyRunProgress,
  applyRunSnapshot,
  placeholderReply,
} from "@/lib/chat-messages"
import {
  isActiveRunStatus,
  textOfParts,
  type ChatMessage,
  type MessagePart,
  type RunHandle,
  type RunSnapshot,
} from "@/lib/chat-types"
import { cn } from "@/lib/utils"

type ChatViewProps = {
  chat: { id: string; title: string; isGroup: boolean }
  bots: { id: string; name: string; job: string; avatar: string }[]
  initialMessages?: ChatMessage[]
  // A reply that was still being written when the page loaded.
  activeRunId?: string | null
}

const SEND_FAILED = "Couldn't reach the server. Check your connection and try again."

export function ChatView(props: ChatViewProps) {
  // The provider lets the view put text back in the box if a message is refused.
  return (
    <PromptInputProvider>
      <ChatViewInner {...props} />
    </PromptInputProvider>
  )
}

function ChatViewInner({
  chat,
  bots,
  initialMessages = [],
  activeRunId = null,
}: ChatViewProps) {
  const router = useRouter()
  const { textInput } = usePromptInputController()
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const [messages, setMessages] = React.useState(initialMessages)
  // The reply being written right now, if any.
  const [run, setRun] = React.useState<RunHandle | null>(null)
  // True from pressing Send until the server has accepted the message.
  const [sending, setSending] = React.useState(false)
  const [stopping, setStopping] = React.useState(false)
  // Why the last message wasn't accepted.
  const [notice, setNotice] = React.useState<string | null>(null)

  // When the server sends a fresh copy of the chat (after router.refresh),
  // show it, so the list matches the database again. A copy that arrives
  // while a reply is being written is older than what's on screen, so it is
  // dropped; another one is requested as soon as the reply ends.
  const [serverMessages, setServerMessages] = React.useState(initialMessages)
  if (initialMessages !== serverMessages) {
    setServerMessages(initialMessages)
    if (!sending && run === null) {
      setMessages(initialMessages)
    }
  }

  // Puts refused text back in the box, unless the user has typed since.
  const restoreText = React.useRef<(text: string) => void>(() => {})
  React.useEffect(() => {
    restoreText.current = (text) => {
      if (!textInput.value) {
        textInput.setInput(text)
      }
    }
  })

  const applySnapshot = React.useCallback(
    (snapshot: RunSnapshot) => {
      setMessages((current) => applyRunSnapshot(current, snapshot))
      if (!isActiveRunStatus(snapshot.status)) {
        // Finished: the list now shows exactly what was saved.
        setRun((current) => (current?.runId === snapshot.id ? null : current))
        setStopping(false)
        // Reload the page's data too: the sidebar shows when the chat was
        // last active, and another tab may have added messages.
        router.refresh()
      }
    },
    [router]
  )

  // The run being followed, readable from effects without re-running them.
  const followedRunId = React.useRef<string | null>(null)
  React.useEffect(() => {
    followedRunId.current = run?.runId ?? null
  })

  // On load, pick up a reply that was still being written. The server action
  // checks that the run is in one of this user's chats.
  React.useEffect(() => {
    // Nothing to do if this screen started the run and is already following.
    if (!activeRunId || followedRunId.current === activeRunId) {
      return
    }

    let cancelled = false
    attachRun(activeRunId)
      .then((attached) => {
        if (cancelled || !attached || followedRunId.current === activeRunId) {
          return
        }
        if (attached.run) {
          setRun(attached.run)
        }
        applySnapshot(attached.snapshot)
      })
      // If this fails the reply is still being written; a reload shows it.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [activeRunId, applySnapshot])

  const busy = sending || run !== null

  function handleSubmit({ text }: PromptInputMessage) {
    const trimmed = text.trim()
    if (!trimmed || busy) {
      return
    }

    void send(trimmed)
  }

  async function send(text: string) {
    setNotice(null)
    setSending(true)

    // Shown at once; swapped for the saved message when the server answers.
    const pendingId = `pending-${Date.now()}`
    setMessages((current) => [
      ...current,
      {
        id: pendingId,
        role: "user",
        botId: null,
        parts: [{ type: "text", text }],
        status: "done",
      },
    ])

    let refusal: string | null = null
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: chat.id, text }),
      })
      const body = (await response.json().catch(() => null)) as {
        run?: RunHandle
        userMessageId?: string
        error?: string
      } | null

      if (response.ok && body?.run && body.userMessageId) {
        const started = body.run
        const userMessageId = body.userMessageId
        setMessages((current) => [
          ...current.map((message) =>
            message.id === pendingId ? { ...message, id: userMessageId } : message
          ),
          placeholderReply(started),
        ])
        setRun(started)
        // The sidebar shows the chat's title and time, which just changed.
        router.refresh()
      } else {
        refusal = body?.error ?? "Something went wrong. Try again."
      }
    } catch {
      refusal = SEND_FAILED
    }

    if (refusal) {
      // The message wasn't saved: take it back out and return the text.
      setMessages((current) =>
        current.filter((message) => message.id !== pendingId)
      )
      restoreText.current(text)
      setNotice(refusal)
    }
    setSending(false)
  }

  async function stop() {
    if (!run || stopping) {
      return
    }

    setStopping(true)
    const result = await stopRun(run.runId)
    if ("error" in result) {
      setStopping(false)
      toast.add({ title: "Couldn't stop the reply", description: result.error })
      return
    }

    applySnapshot(result.run)
  }

  async function removeChat() {
    setDeleting(true)
    const result = await deleteChat(chat.id)
    setDeleting(false)

    if ("error" in result) {
      toast.add({ title: "Couldn't delete the chat", description: result.error })
      return
    }

    setDeleteOpen(false)
    router.push("/")
  }

  const bot = chat.isGroup ? null : bots[0]
  const heading = chat.isGroup ? chat.title : (bot?.name ?? chat.title)
  // A reply with nothing in it yet is shown as "Thinking…"; one that is over
  // and still empty has nothing to show.
  const visible = messages.filter(
    (message) =>
      message.role === "user" ||
      message.parts.length > 0 ||
      message.id === run?.assistantMessageId
  )
  const empty = visible.length === 0 && !notice

  return (
    <div className="flex min-h-0 flex-1">
      {run && (
        <RunFollower
          key={run.runId}
          run={run}
          onSnapshot={applySnapshot}
          onProgress={(parts: MessagePart[]) =>
            setMessages((current) => applyRunProgress(current, run, parts))
          }
          onGone={() => {
            setRun(null)
            setStopping(false)
            router.refresh()
          }}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 max-md:pl-12">
          <div className="flex min-w-0 items-center gap-3">
            {bot ? (
              <BotAvatar name={bot.name} seed={bot.avatar} size="lg" />
            ) : (
              <UsersIcon className="size-5 text-muted-foreground" />
            )}
            <div className="flex min-w-0 flex-col leading-tight">
              <h1 className="truncate text-sm font-medium">{heading}</h1>
              {bot && (
                <span className="truncate text-xs text-muted-foreground">
                  {bot.job}
                </span>
              )}
            </div>
            {chat.isGroup && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {bots.length} {bots.length === 1 ? "bot" : "bots"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete chat"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon />
            </Button>
            {bot && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`${workspaceOpen ? "Hide" : "Show"} ${bot.name}'s screen`}
                aria-pressed={workspaceOpen}
                className={cn(workspaceOpen && "bg-muted")}
                onClick={() => setWorkspaceOpen((open) => !open)}
              >
                <MonitorIcon />
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {empty ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  {bot ? (
                    <BotAvatar name={bot.name} seed={bot.avatar} />
                  ) : (
                    <UsersIcon className="size-6 text-muted-foreground" />
                  )}
                </EmptyMedia>
                <EmptyTitle>{heading}</EmptyTitle>
                <EmptyDescription>
                  {bot
                    ? bot.job
                    : `${bots.map((member) => member.name).join(", ")}. Start a message with @name to pick who answers.`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Conversation className="min-h-0">
              <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
                {visible.map((message) => {
                  if (message.status === "error") {
                    return (
                      <ErrorBubble
                        key={message.id}
                        text={textOfParts(message.parts)}
                      />
                    )
                  }

                  const text = textOfParts(message.parts)
                  const writing = message.id === run?.assistantMessageId
                  const speaker =
                    message.role === "assistant"
                      ? (bots.find((member) => member.id === message.botId) ??
                        bot)
                      : null

                  const bubble = (
                    <Message
                      key={message.id}
                      from={message.role}
                      className={speaker ? "max-w-full flex-1" : "max-w-[80%]"}
                    >
                      {chat.isGroup && speaker && (
                        <span className="px-1 text-xs text-muted-foreground">
                          {speaker.name}
                        </span>
                      )}
                      <MessageContent
                        className={cn(
                          "group-[.is-user]:rounded-2xl group-[.is-user]:bg-foreground/22 group-[.is-user]:px-3 group-[.is-user]:py-2",
                          "group-[.is-assistant]:rounded-2xl group-[.is-assistant]:bg-secondary group-[.is-assistant]:px-3 group-[.is-assistant]:py-2",
                          writing &&
                            message.parts.length === 0 &&
                            "group-[.is-assistant]:w-fit"
                        )}
                      >
                        {message.role === "user" ? (
                          <span className="whitespace-pre-wrap">{text}</span>
                        ) : message.parts.length === 0 ? (
                          <Shimmer>Thinking…</Shimmer>
                        ) : (
                          // Text and tool calls, in the order they happened.
                          message.parts.map((part, index) =>
                            part.type === "tool" ? (
                              <ToolCard
                                key={part.id}
                                part={part}
                                // A call still "running" in a reply that is
                                // over was cut short by Stop.
                                interrupted={!writing}
                              />
                            ) : (
                              <MessageResponse
                                key={index}
                                isAnimating={
                                  writing && index === message.parts.length - 1
                                }
                              >
                                {part.text}
                              </MessageResponse>
                            )
                          )
                        )}
                      </MessageContent>
                    </Message>
                  )

                  if (!speaker) {
                    return bubble
                  }

                  return (
                    <div
                      key={message.id}
                      className="flex max-w-[85%] items-start gap-2.5"
                    >
                      <BotAvatar
                        name={speaker.name}
                        seed={speaker.avatar}
                        className="mt-0.5 shrink-0"
                      />
                      {bubble}
                    </div>
                  )
                })}

                {notice && <ErrorBubble text={notice} />}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
          )}
        </div>

        <PromptInput
          className="mx-auto w-full max-w-3xl shrink-0 p-4"
          groupClassName="rounded-xl bg-secondary dark:bg-secondary"
          onSubmit={handleSubmit}
        >
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                chat.isGroup
                  ? "Message, or @name to pick a bot"
                  : "What would you like to know?"
              }
              maxLength={MAX_MESSAGE_LENGTH}
              rows={1}
              className="min-h-0 px-3 pt-2.5 pb-1.5"
            />
          </PromptInputBody>
          <PromptInputFooter className="px-2.5 pb-2.5">
            <PromptInputTools>
              <PromptInputButton size="icon-sm" aria-label="Add attachment">
                <PlusIcon />
              </PromptInputButton>
            </PromptInputTools>
            <PromptInputSubmit
              // "streaming" shows the Stop button; "submitted" a spinner.
              status={
                run && !stopping ? "streaming" : busy ? "submitted" : "ready"
              }
              onStop={stop}
              // Not `disabled`: that would dim the whole composer.
              aria-disabled={!busy && !textInput.value.trim()}
              className="aria-disabled:opacity-50"
            />
          </PromptInputFooter>
        </PromptInput>
      </div>

      {bot && workspaceOpen && (
        <aside className="hidden w-64 shrink-0 flex-col border-l md:flex">
          <div className="flex h-10 shrink-0 items-center justify-end px-3">
            <Button variant="ghost" size="icon-sm" aria-label="Refresh screen">
              <RefreshCwIcon />
            </Button>
          </div>
          <div className="flex flex-col items-center gap-3 p-3">
            {/* The bot's screen isn't connected yet, so this is a placeholder. */}
            <div className="flex aspect-16/10 w-full items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
              <MonitorIcon />
            </div>
            <p className="text-xs text-muted-foreground">
              {bot.name}&apos;s screen
            </p>
          </div>
        </aside>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The chat and all of its messages will be deleted. This can&apos;t
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={removeChat}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// A reply that failed, shown in the thread so it's never a silent failure.
function ErrorBubble({ text }: { text: string }) {
  return (
    <Message from="assistant" className="max-w-[80%]">
      <MessageContent
        role="alert"
        className="group-[.is-assistant]:w-fit group-[.is-assistant]:rounded-2xl group-[.is-assistant]:bg-destructive/10 group-[.is-assistant]:px-3 group-[.is-assistant]:py-2 group-[.is-assistant]:text-destructive"
      >
        {text}
      </MessageContent>
    </Message>
  )
}
