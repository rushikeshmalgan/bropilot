// Prompt building and the model call. Everything that asks the model for a bot
// reply goes through runModel, so the prompt and the limits live in one place.
import {
  isStepCount,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai"

import {
  MAX_HISTORY_MESSAGES,
  MAX_OUTPUT_TOKENS,
  MAX_STEPS,
  model as defaultModel,
} from "@/lib/ai"
import type { Message } from "@/lib/db/schema"

type ChatBot = { id: string; name: string; job: string }
type PromptBot = { name: string; job: string; instructions: string | null }

// The text in a message, whether it's stored or in the middle of streaming.
export function textOf(message: { parts: readonly unknown[] }) {
  return message.parts
    .map((part) => {
      const { type, text } = part as { type?: unknown; text?: unknown }
      return type === "text" && typeof text === "string" ? text : ""
    })
    .join("")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Which bot answers. In a group chat the user can address one with @name; with
// no mention it's the bot that spoke last, or the first bot if none has yet.
export function pickBot<T extends ChatBot>(
  bots: T[],
  text: string,
  history: Pick<Message, "role" | "botId">[]
): T {
  if (bots.length > 1) {
    // Longest names first so "@Ann Marie" isn't read as "@Ann".
    const byLength = [...bots].sort((a, b) => b.name.length - a.name.length)
    const mentioned = byLength.find((bot) =>
      new RegExp(
        `(^|\\s)@${escapeRegExp(bot.name)}(?![\\p{L}\\p{N}_])`,
        "iu"
      ).test(text)
    )
    if (mentioned) {
      return mentioned
    }

    const lastSpeakerId = [...history]
      .reverse()
      .find((message) => message.role === "assistant" && message.botId)?.botId
    const lastSpeaker = bots.find((bot) => bot.id === lastSpeakerId)
    if (lastSpeaker) {
      return lastSpeaker
    }
  }

  return bots[0]
}

// A bot's persona comes from its name, job and instructions.
export function buildSystemPrompt(bot: PromptBot, otherBotNames: string[]) {
  return [
    `You are ${bot.name}, an AI assistant. Your job: ${bot.job}.`,
    bot.instructions?.trim()
      ? `How you should work:\n${bot.instructions.trim()}`
      : null,
    otherBotNames.length > 0
      ? `You are in a group chat with the user and these other bots: ${otherBotNames.join(", ")}. Reply only as ${bot.name}. Messages from other bots are shown with their name in front.`
      : null,
    "Be helpful and concise. Follow the instructions above exactly, including any limits on length or format.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

// The stored transcript as the model should see it. Failed replies, replies
// still being written and empty messages are left out. In a group chat, other
// bots' replies are shown as context from the user's side, with the bot's name.
// Neighbouring messages from the same side are merged, because models expect
// the sides to alternate.
export function toModelMessages(
  history: Pick<Message, "role" | "botId" | "status" | "parts">[],
  botId: string,
  botNames: Map<string, string>,
  isGroup: boolean
): ModelMessage[] {
  const result: { role: "user" | "assistant"; content: string }[] = []

  for (const message of history) {
    const text = textOf(message).trim()
    if (!text || message.status !== "done") {
      continue
    }

    let role: "user" | "assistant" = message.role
    let content = text
    if (message.role === "assistant" && message.botId !== botId) {
      role = "user"
      content = isGroup
        ? `${botNames.get(message.botId ?? "") ?? "Another bot"}: ${text}`
        : text
    }

    const last = result[result.length - 1]
    if (last && last.role === role) {
      last.content += `\n\n${content}`
    } else {
      result.push({ role, content })
    }
  }

  // The conversation has to start with the user.
  while (result.length > 0 && result[0].role !== "user") {
    result.shift()
  }

  return result
}

export type RunModelInput = {
  // The bot that answers, with its instructions.
  bot: PromptBot & { id: string }
  // Every bot in the chat, the answering one included.
  chatBots: { id: string; name: string }[]
  isGroup: boolean
  // The chat's messages, oldest first. Only the most recent ones are sent.
  history: Pick<Message, "role" | "botId" | "status" | "parts">[]
  model?: LanguageModel
  tools?: ToolSet
  abortSignal?: AbortSignal
}

// Starts one model call for a bot reply and returns the AI SDK's stream. The
// caller decides what to do with errors; nothing is retried here.
export function runModel({
  bot,
  chatBots,
  isGroup,
  history,
  model = defaultModel,
  tools,
  abortSignal,
}: RunModelInput) {
  const names = new Map(chatBots.map((member) => [member.id, member.name]))
  const hasTools = tools !== undefined && Object.keys(tools).length > 0

  return streamText({
    model,
    instructions: buildSystemPrompt(
      bot,
      chatBots.filter((member) => member.id !== bot.id).map((m) => m.name)
    ),
    messages: toModelMessages(
      history.slice(-MAX_HISTORY_MESSAGES),
      bot.id,
      names,
      isGroup
    ),
    tools: hasTools ? tools : undefined,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    stopWhen: isStepCount(MAX_STEPS),
    // Retries are handled by the run, which knows how long it may take.
    maxRetries: 0,
    abortSignal,
    // Errors are read from the stream; this keeps the SDK from also logging
    // them to the console.
    onError: () => {},
  })
}
