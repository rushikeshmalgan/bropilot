"use client"

import * as React from "react"
import {
  CornerDownLeftIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"

import { BotAvatar } from "@/components/bot-avatar"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Message } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { cn } from "@/lib/utils"

export type ChatMessage = {
  id: string
  role: "user" | "bot"
  text: string
}

export function ChatView({
  bot,
  initialMessages = [],
}: {
  bot: { id: string; name: string; job: string }
  initialMessages?: ChatMessage[]
}) {
  const [messages, setMessages] = React.useState(initialMessages)
  const [draft, setDraft] = React.useState("")
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false)

  // Messages aren't stored anywhere yet, so they only live on this page.
  function send() {
    const text = draft.trim()
    if (!text) {
      return
    }

    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", text },
    ])
    setDraft("")
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center justify-between border-b px-3 max-md:pl-12">
          <div className="flex items-center gap-1.5">
            <BotAvatar name={bot.name} className="size-3.5" />
            <h1 className="text-sm">{bot.name}</h1>
          </div>
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
        </header>

        <div className="min-h-0 flex-1">
          {messages.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <BotAvatar name={bot.name} />
                </EmptyMedia>
                <EmptyTitle>{bot.name}</EmptyTitle>
                <EmptyDescription>{bot.job}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScrollerProvider autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="gap-8 px-6 pt-4 pb-4">
                    {messages.map((message) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.role === "user"}
                      >
                        <Message
                          align={message.role === "user" ? "end" : "start"}
                        >
                          <Bubble
                            variant="secondary"
                            align={message.role === "user" ? "end" : "start"}
                          >
                            <BubbleContent
                              className={cn(
                                "rounded-2xl leading-[21px]",
                                message.role === "user" && "bg-foreground/22!"
                              )}
                            >
                              {message.text}
                            </BubbleContent>
                          </Bubble>
                        </Message>
                      </MessageScrollerItem>
                    ))}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          )}
        </div>

        <form
          className="shrink-0 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <InputGroup className="rounded-xl bg-secondary dark:bg-secondary">
            <InputGroupTextarea
              placeholder="What would you like to know?"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  send()
                }
              }}
              className="min-h-0 px-3 pt-2.5 pb-1.5"
            />
            <InputGroupAddon align="block-end" className="px-2.5 pb-2.5">
              <InputGroupButton size="icon-sm" aria-label="Add attachment">
                <PlusIcon />
              </InputGroupButton>
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-sm"
                aria-label="Send"
                // Not `disabled`: that would dim the whole input group.
                aria-disabled={!draft.trim()}
                className="ml-auto aria-disabled:opacity-50"
              >
                <CornerDownLeftIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>

      {workspaceOpen && (
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
    </div>
  )
}
