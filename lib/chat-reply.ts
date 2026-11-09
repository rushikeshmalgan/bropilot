import {
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai"
import { nanoid } from "nanoid"

import {
  MAX_HISTORY_MESSAGES,
  MAX_OUTPUT_TOKENS,
  MAX_STEPS,
  RATE_LIMITED_MESSAGE,
  buildSystemPrompt,
  describeModelError,
  model as defaultModel,
} from "@/lib/ai"
import {
  MAX_MESSAGE_LENGTH,
  insertAssistantMessage,
  insertUserMessage,
  selectBot,
  selectChat,
  selectMessages,
} from "@/lib/chat-store"
import type { ChatMessageMetadata, ChatUIMessage } from "@/lib/chat-types"
import type { Message, MessageUsage } from "@/lib/db/schema"
import { checkRateLimit } from "@/lib/rate-limit"

type ChatBot = { id: string; name: string; job: string }

// The text in a message, whether it's stored or in the middle of streaming.
function textOf(message: { parts: readonly unknown[] }) {
  return message.parts
    .map((part) => {
      const { type, text } = part as { type?: unknown; text?: unknown }
      return type === "text" && typeof text === "string" ? text : ""
    })
    .join("")
}

// The token counts for a finished reply, or null if the provider gave none.
async function readUsage(result: {
  totalUsage: PromiseLike<{
    inputTokens: number | undefined
    outputTokens: number | undefined
    totalTokens: number | undefined
  }>
}): Promise<MessageUsage | null> {
  try {
    const usage = await result.totalUsage
    return {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
    }
  } catch {
    return null
  }
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
      new RegExp(`(^|\\s)@${escapeRegExp(bot.name)}(?![\\p{L}\\p{N}_])`, "iu").test(
        text
      )
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

// The stored transcript as the model should see it. Failed replies and empty
// messages are left out. In a group chat, other bots' replies are shown as
// context from the user's side, with the bot's name. Neighbouring messages from
// the same side are merged, because models expect the sides to alternate.
export function toModelMessages(
  history: Pick<Message, "role" | "botId" | "status" | "parts">[],
  botId: string,
  botNames: Map<string, string>,
  isGroup: boolean
): ModelMessage[] {
  const result: { role: "user" | "assistant"; content: string }[] = []

  for (const message of history) {
    const text = textOf(message).trim()
    if (!text || message.status === "error") {
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

function errorResponse(
  status: number,
  code: string,
  error: string,
  headers?: HeadersInit
) {
  return Response.json({ error, code }, { status, headers })
}

// Saves the user's message, asks the bot for a reply and streams it back,
// saving the reply (or the error) when it ends. The caller has already checked
// who the user is.
export async function replyToMessage({
  userId,
  chatId,
  text: rawText,
  model = defaultModel,
}: {
  userId: string
  chatId: string
  text: string
  model?: LanguageModel
}): Promise<Response> {
  const text = rawText.trim()
  if (!text) {
    return errorResponse(400, "empty_message", "Write a message first.")
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return errorResponse(
      400,
      "message_too_long",
      `Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`
    )
  }

  const limit = checkRateLimit(userId)
  if (!limit.ok) {
    return errorResponse(429, "rate_limited", RATE_LIMITED_MESSAGE, {
      "Retry-After": String(limit.retryAfterSeconds),
    })
  }

  // A chat that isn't the user's is the same as one that doesn't exist.
  const chat = await selectChat(userId, chatId)
  if (!chat || chat.bots.length === 0) {
    return errorResponse(404, "not_found", "That chat doesn't exist.")
  }

  // The user's message is saved before the model is called, so it's kept even
  // if the reply fails.
  if (!(await insertUserMessage(userId, chatId, text))) {
    return errorResponse(404, "not_found", "That chat doesn't exist.")
  }

  const history = await selectMessages(userId, chatId)
  const isGroup = chat.botId === null
  const bot = pickBot(chat.bots, text, history)
  const names = new Map(chat.bots.map((member) => [member.id, member.name]))

  // The bot's instructions aren't in the chat's bot list, so load the bot.
  const persona = (await selectBot(userId, bot.id)) ?? {
    ...bot,
    instructions: null,
  }

  const assistantId = nanoid()
  let streamError: unknown

  const result = streamText({
    model,
    instructions: buildSystemPrompt(
      persona,
      chat.bots.filter((member) => member.id !== bot.id).map((m) => m.name)
    ),
    messages: toModelMessages(
      history.slice(-MAX_HISTORY_MESSAGES),
      bot.id,
      names,
      isGroup
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    stopWhen: isStepCount(MAX_STEPS),
    maxRetries: 1,
    onError: ({ error }) => {
      streamError ??= error
      console.error("Model error:", error)
    },
  })

  // Keep going and save the reply even if the browser disconnects.
  void result.consumeStream()

  return createUIMessageStreamResponse({
    stream: toUIMessageStream<ToolSet, ChatUIMessage>({
      stream: result.stream,
      generateMessageId: () => assistantId,
      messageMetadata: ({ part }): ChatMessageMetadata | undefined =>
        part.type === "start"
          ? { botId: bot.id, botName: bot.name }
          : undefined,
      // What the browser is told when the model call fails.
      onError: (error) => {
        streamError ??= error
        return describeModelError(error)
      },
      onEnd: async ({ responseMessage, outcome }) => {
        try {
          const replyText = textOf(responseMessage).trim()
          const failed = streamError !== undefined || outcome.status === "failed"

          if (failed || (outcome.status === "completed" && !replyText)) {
            await insertAssistantMessage(userId, {
              id: assistantId,
              chatId,
              botId: bot.id,
              text: describeModelError(
                streamError ?? (outcome.status === "failed" ? outcome.error : "")
              ),
              status: "error",
            })
          } else if (replyText) {
            // Completed, or stopped by the user with part of a reply.
            const usage = await readUsage(result)
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[usage] ${bot.name}: ${usage?.inputTokens ?? "?"} in, ${usage?.outputTokens ?? "?"} out, ${usage?.totalTokens ?? "?"} total`
              )
            }

            await insertAssistantMessage(userId, {
              id: assistantId,
              chatId,
              botId: bot.id,
              text: replyText,
              status: "done",
              usage,
            })
          }
        } catch (error) {
          console.error("Couldn't save the reply:", error)
        }
      },
    }),
  })
}
