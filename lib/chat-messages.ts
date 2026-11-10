// How the chat screen's message list changes as a run reports in. Pure
// functions, so the rules can be tested without a browser.
import {
  isActiveRunStatus,
  type ChatMessage,
  type MessagePart,
  type RunSnapshot,
} from "@/lib/chat-types"

// Replaces the message with the same ID where it stands, or adds it at the end.
export function upsertMessage(
  list: ChatMessage[],
  message: ChatMessage
): ChatMessage[] {
  const index = list.findIndex((item) => item.id === message.id)
  if (index === -1) {
    return [...list, message]
  }

  const next = [...list]
  next[index] = message
  return next
}

// The reply a run is writing, before any of it has been saved.
export function placeholderReply(run: {
  assistantMessageId: string
  botId: string
}): ChatMessage {
  return {
    id: run.assistantMessageId,
    role: "assistant",
    botId: run.botId,
    parts: [],
    status: "streaming",
  }
}

// Shows a run's saved state. While the run is unfinished its reply is always
// in the list (empty at first). Once it has finished, the list holds exactly
// what the database holds: the saved reply, or nothing if none was written.
export function applyRunSnapshot(
  list: ChatMessage[],
  snapshot: RunSnapshot
): ChatMessage[] {
  if (snapshot.message) {
    return upsertMessage(list, snapshot.message)
  }

  if (isActiveRunStatus(snapshot.status)) {
    return list.some((item) => item.id === snapshot.assistantMessageId)
      ? list
      : [...list, placeholderReply(snapshot)]
  }

  return list.filter((item) => item.id !== snapshot.assistantMessageId)
}

// Shows text that arrived through live updates, ahead of the next saved state.
export function applyRunProgress(
  list: ChatMessage[],
  run: { assistantMessageId: string; botId: string },
  parts: MessagePart[]
): ChatMessage[] {
  return upsertMessage(list, { ...placeholderReply(run), parts })
}
