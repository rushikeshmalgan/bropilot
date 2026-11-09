import { google } from "@ai-sdk/google"

// The model every bot uses. Change this one line to switch models. This is the
// cheapest Gemini Flash-Lite model, which suits the free tier.
export const MODEL_ID = "gemini-3.5-flash-lite"
export const model = google(MODEL_ID)

// Limits.
export const MAX_OUTPUT_TOKENS = 1024
// The cap on model steps per reply. There are no tools yet, so this is 1 in
// practice; it stays low so adding tools can't run up the free tier.
export const MAX_STEPS = 2
// How many of the most recent messages are sent to the model.
export const MAX_HISTORY_MESSAGES = 30
// Messages per user per window (in memory, so per server instance).
export const RATE_LIMIT_MAX_MESSAGES = 10
export const RATE_LIMIT_WINDOW_MS = 60_000

export const BUSY_MESSAGE = "The model is busy, try again in a minute."
export const RATE_LIMITED_MESSAGE =
  "You're sending messages too quickly. Try again in a minute."
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong with that reply. Try again."

type PromptBot = { name: string; job: string; instructions: string | null }

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

// Looks through an error and the errors inside it for an HTTP status code.
function findStatusCode(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 4) {
    return undefined
  }

  const record = error as Record<string, unknown>
  if (typeof record.statusCode === "number") {
    return record.statusCode
  }

  for (const inner of [record.lastError, record.cause]) {
    const code = findStatusCode(inner, depth + 1)
    if (code !== undefined) {
      return code
    }
  }

  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) {
      const code = findStatusCode(inner, depth + 1)
      if (code !== undefined) {
        return code
      }
    }
  }

  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "")
}

// Turns whatever the model call threw into a message that's safe and useful to
// show in the chat. The real error is logged on the server, not shown.
export function describeModelError(error: unknown): string {
  const status = findStatusCode(error)
  const text = errorText(error)

  // A rate limit or an exhausted free-tier quota.
  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(text)) {
    return BUSY_MESSAGE
  }
  // The provider is overloaded or down.
  if (status === 503 || status === 529 || /overloaded|unavailable/i.test(text)) {
    return BUSY_MESSAGE
  }
  // A missing or rejected API key.
  if (
    status === 401 ||
    status === 403 ||
    /API key|LoadAPIKeyError/i.test(text)
  ) {
    return "The AI service isn't set up correctly yet."
  }

  return GENERIC_ERROR_MESSAGE
}
