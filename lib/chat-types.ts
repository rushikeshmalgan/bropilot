import type { UIMessage } from "ai"

// What the chat attaches to each message besides its text.
export type ChatMessageMetadata = {
  // Which bot wrote an assistant message.
  botId?: string | null
  botName?: string
  // "error" marks a reply that failed; its text says why.
  status?: "done" | "error"
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata>
