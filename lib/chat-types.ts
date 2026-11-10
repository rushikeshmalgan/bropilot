// Types the browser and the server share. Nothing here touches the database,
// so client components can import it.
import type { MessagePart, MessageUsage, RunStatus } from "@/lib/db/schema"

export type { MessagePart, MessageUsage, RunStatus }

// A message as the chat screen shows it.
export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  // Which bot wrote an assistant message.
  botId: string | null
  parts: MessagePart[]
  // "streaming" is a reply still being written; "error" is one that failed,
  // and its text says why.
  status: "streaming" | "done" | "error"
}

// Where a run stands, as read from the database. Once status is done, error or
// cancelled it never changes, and `message` is the saved reply (null if the
// run ended before writing anything).
export type RunSnapshot = {
  id: string
  status: RunStatus
  // Safe to show the user; set when status is "error".
  error: string | null
  assistantMessageId: string
  botId: string
  message: ChatMessage | null
}

// What the browser needs to follow a run it just started or found on load.
export type RunHandle = {
  runId: string
  assistantMessageId: string
  botId: string
  // Set when live updates are available; otherwise the browser polls.
  live: { externalId: string; token: string } | null
}

export function isActiveRunStatus(status: RunStatus) {
  return status === "queued" || status === "running"
}

// Progress a worker publishes while a run is in flight. `seq` only goes up, so
// a late update can be told from a newer one.
export type RunProgress = {
  seq: number
  parts: MessagePart[]
}

export function textOfParts(parts: readonly MessagePart[]) {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("")
}
