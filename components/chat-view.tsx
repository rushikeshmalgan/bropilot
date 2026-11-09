"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
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
import { deleteChat } from "@/lib/actions"
import { MAX_MESSAGE_LENGTH } from "@/lib/chat-limits"
import type { ChatUIMessage } from "@/lib/chat-types"
import { cn } from "@/lib/utils"

type ChatViewProps = {
  chat: { id: string; title: string; isGroup: boolean }
  bots: { id: string; name: string; job: string; avatar: string }[]
  initialMessages?: ChatUIMessage[]
}

function textOf(message: ChatUIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

// What to show when a request fails, and whether the user's message was never
// saved. The server answers with JSON for requests it turned away (not signed
// in, too many messages, ...); a failure while the reply streams is plain text.
function describeError(error: Error): { message: string; unsaved: boolean } {
  try {
    const body = JSON.parse(error.message) as { error?: unknown }
    if (typeof body.error === "string") {
      return { message: body.error, unsaved: true }
    }
  } catch {
    // Not JSON, so it came from the stream.
  }

  if (error instanceof TypeError) {
    return {
      message: "Couldn't reach the server. Check your connection and try again.",
      unsaved: true,
    }
  }

  return {
    message: error.message || "Something went wrong. Try again.",
    unsaved: false,
  }
}

export function ChatView(props: ChatViewProps) {
  // The provider lets the view put text back in the box if a message is refused.
  return (
    <PromptInputProvider>
      <ChatViewInner {...props} />
    </PromptInputProvider>
  )
}

function ChatViewInner({ chat, bots, initialMessages = [] }: ChatViewProps) {
  const router = useRouter()
  const { textInput } = usePromptInputController()
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  // The newest message and its text, kept for when a send is refused.
  const lastSent = React.useRef("")
  const restoreText = React.useRef<(text: string) => void>(() => {})
  React.useEffect(() => {
    restoreText.current = (text) => {
      if (!textInput.value) {
        textInput.setInput(text)
      }
    }
  })

  // Only the newest message is sent; the server loads the rest from the
  // database, so history can't be forged from the browser.
  const transport = React.useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: { id, message: messages[messages.length - 1] },
        }),
      }),
    []
  )

  const { messages, sendMessage, status, stop, error, setMessages } =
    useChat<ChatUIMessage>({
      id: chat.id,
      messages: initialMessages,
      transport,
      onError: (failure) => {
        // A message the server turned away wasn't saved: take it back out of
        // the thread and give the text back to the user.
        if (describeError(failure).unsaved) {
          setMessages((current) =>
            current[current.length - 1]?.role === "user"
              ? current.slice(0, -1)
              : current
          )
          restoreText.current(lastSent.current)
        }
      },
    })

  const busy = status === "submitted" || status === "streaming"
  const last = messages[messages.length - 1]
  const thinking =
    status === "submitted" ||
    (status === "streaming" && last?.role === "assistant" && !textOf(last))

  function handleSubmit({ text }: PromptInputMessage) {
    const trimmed = text.trim()
    if (!trimmed || busy) {
      return
    }

    lastSent.current = trimmed
    void sendMessage({ text: trimmed })
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
  const visible = messages.filter(
    (message) => message.role === "user" || textOf(message)
  )
  const empty = visible.length === 0 && !thinking && !error

  return (
    <div className="flex min-h-0 flex-1">
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
                {visible.map((message, index) => {
                  if (message.metadata?.status === "error") {
                    return (
                      <ErrorBubble key={message.id} text={textOf(message)} />
                    )
                  }

                  const streamingThis =
                    status === "streaming" && index === visible.length - 1

                  const speaker =
                    message.role === "assistant"
                      ? (bots.find(
                          (member) => member.id === message.metadata?.botId
                        ) ?? bot)
                      : null

                  const bubble = (
                    <Message
                      key={message.id}
                      from={message.role}
                      className={speaker ? "max-w-full flex-1" : "max-w-[80%]"}
                    >
                      {chat.isGroup &&
                        message.role === "assistant" &&
                        message.metadata?.botName && (
                          <span className="px-1 text-xs text-muted-foreground">
                            {message.metadata.botName}
                          </span>
                        )}
                      <MessageContent
                        className={cn(
                          "group-[.is-user]:rounded-2xl group-[.is-user]:bg-foreground/22 group-[.is-user]:px-3 group-[.is-user]:py-2",
                          "group-[.is-assistant]:rounded-2xl group-[.is-assistant]:bg-secondary group-[.is-assistant]:px-3 group-[.is-assistant]:py-2"
                        )}
                      >
                        {message.role === "assistant" ? (
                          <MessageResponse isAnimating={streamingThis}>
                            {textOf(message)}
                          </MessageResponse>
                        ) : (
                          <span className="whitespace-pre-wrap">
                            {textOf(message)}
                          </span>
                        )}
                      </MessageContent>
                    </Message>
                  )

                  if (!speaker) {
                    return bubble
                  }

                  return (
                    <div key={message.id} className="flex max-w-[85%] items-start gap-2.5">
                      <BotAvatar
                        name={speaker.name}
                        seed={speaker.avatar}
                        className="mt-0.5 shrink-0"
                      />
                      {bubble}
                    </div>
                  )
                })}

                {thinking && (
                  <Message from="assistant" className="max-w-[80%]">
                    <MessageContent className="group-[.is-assistant]:w-fit group-[.is-assistant]:rounded-2xl group-[.is-assistant]:bg-secondary group-[.is-assistant]:px-3 group-[.is-assistant]:py-2">
                      <Shimmer>Thinking…</Shimmer>
                    </MessageContent>
                  </Message>
                )}

                {error && status === "error" && (
                  <ErrorBubble text={describeError(error).message} />
                )}
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
              status={status}
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
