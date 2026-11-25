import { google } from "@ai-sdk/google"

// The model every bot uses. Change this one line to switch models. This is the
// cheapest Gemini Flash-Lite model, which suits the free tier.
export const MODEL_ID = "gemini-3.5-flash-lite"
export const model = google(MODEL_ID)

// Limits.
export const MAX_OUTPUT_TOKENS = 1024
// The cap on model steps per reply when the bot has no tools. One step is
// all a plain reply needs; this stays low to protect the free tier.
export const MAX_STEPS = 2
// With tools, a reply needs room to call a few and then answer.
export const MAX_STEPS_WITH_TOOLS = 6
// With a screen to use, a reply is a series of look, act, look steps.
export const MAX_STEPS_WITH_COMPUTER = 24
// How many of the most recent messages are sent to the model.
export const MAX_HISTORY_MESSAGES = 30
// Messages per user per window (in memory, so per server instance).
export const RATE_LIMIT_MAX_MESSAGES = 10
export const RATE_LIMIT_WINDOW_MS = 60_000

// The longest a run may take from start to finish, retries included.
export const MAX_RUN_DURATION_MS = 5 * 60_000
// A 429 is retried with exponential backoff: this long, then twice as long.
export const MODEL_RETRY_BASE_MS = 2000
// Attempts in total when the model keeps answering 429.
export const MAX_RATE_LIMIT_ATTEMPTS = 3
// How often a run saves its progress and checks whether it was stopped.
export const RUN_PROGRESS_INTERVAL_MS = 1000

export const BUSY_MESSAGE = "The model is busy, try again in a minute."
export const RATE_LIMITED_MESSAGE =
  "You're sending messages too quickly. Try again in a minute."
export const GENERIC_ERROR_MESSAGE =
  "Something went wrong with that reply. Try again."
export const RUN_TIMEOUT_MESSAGE =
  "The reply took too long and was stopped. Try again."
export const CHAT_BUSY_MESSAGE =
  "The bot is still replying. Wait for it to finish, or stop it."
// Shown to anyone who sends a message, so it names no setting. The log at
// start-up, /api/health and `npm run check:env` say what is missing.
export const NOT_CONFIGURED_MESSAGE =
  "Replies aren't switched on for this app yet. Whoever runs it needs to finish setting it up. Your message wasn't sent."
export const OUT_OF_STEPS_MESSAGE =
  "I used my tools but ran out of room before writing an answer. Ask me to continue."
// The most model tokens (what it read plus what it wrote, over all its steps)
// one reply may use. Every step sends the whole conversation again, with
// everything the tools returned, so cost grows with each step; this is the
// cap on a reply that keeps reading pages.
export const MAX_RUN_TOKENS = 200_000
// Replies one user may have being written at the same moment, in all their
// chats. The monthly allowance is checked when a reply starts, so without this
// a user could start many replies before any of them is counted.
export const MAX_ACTIVE_RUNS_PER_USER = 3
export const TOO_MANY_REPLIES_MESSAGE = `You already have ${MAX_ACTIVE_RUNS_PER_USER} replies being written. Wait for one to finish, or stop one, and try again.`
export const ENQUEUE_FAILED_MESSAGE =
  "Couldn't start the reply. Try again in a moment."

// Looks through an error and the errors inside it for an HTTP status code.
export function findStatusCode(error: unknown, depth = 0): number | undefined {
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

// What to do after a failed model call.
// - rate_limit: a 429; retry with backoff, up to MAX_RATE_LIMIT_ATTEMPTS
// - retry_once: a network failure or a 5xx; worth one more try
// - fatal: any other 4xx, or an error we don't recognise; retrying won't help
export type ModelErrorKind = "rate_limit" | "retry_once" | "fatal"

function looksLikeNetworkError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) {
    return false
  }

  const record = error as Record<string, unknown>
  const code = typeof record.code === "string" ? record.code : ""
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR)/.test(code)) {
    return true
  }
  if (
    /fetch failed|network|socket hang up|connection (reset|closed)/i.test(
      errorText(error)
    )
  ) {
    return true
  }

  return looksLikeNetworkError(record.cause, depth + 1)
}

export function classifyModelError(error: unknown): ModelErrorKind {
  const status = findStatusCode(error)

  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(errorText(error))) {
    return "rate_limit"
  }
  if (status !== undefined) {
    return status >= 500 ? "retry_once" : "fatal"
  }

  return looksLikeNetworkError(error) ? "retry_once" : "fatal"
}
