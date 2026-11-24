// What may leave this app for Sentry. Every event, transaction and span goes
// through here first (beforeSend, beforeSendTransaction, beforeSendSpan), and
// anything that can't be cleaned is dropped rather than sent.
//
// The rule is "allow what we know is safe", not "remove what we know is bad":
// an event keeps its error type, a short cleaned message, the stack, the route
// and four IDs (userId, botId, chatId, runId). Everything a person typed or a
// tool returned (message text, memory files, command output, page text) lives
// under a handful of field names, and those are replaced wherever they appear.
// On top of that, any text shaped like a key or token is replaced, wherever it
// is.
//
// This file imports nothing from Sentry, so it is easy to test on its own.

export const REDACTED = "[redacted]"

// Text longer than this is cut, after cleaning.
export const MAX_STRING_CHARS = 300
// Cleaning looks at no more than this much of a string, so a huge one can't
// make it slow. The rest is cut.
const MAX_INPUT_CHARS = 10_000
const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 50

// The four IDs an event may be tagged with. Anything else is not sent as a tag.
export const TAG_NAMES = ["userId", "botId", "chatId", "runId"] as const
export type TagName = (typeof TAG_NAMES)[number]
export type Tags = Partial<Record<TagName, string>>

// Clerk user IDs and our own nanoids fit this; a stray secret or a sentence
// does not.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

// Text that looks like a credential. These are the shapes of the keys this app
// uses, then the general shapes (bearer headers, JWTs, passwords in URLs).
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic style keys.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Google API keys (Gemini).
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // Trigger.dev keys and tokens (tr_dev_..., tr_prod_..., tr_pat_...).
  /\btr_[a-z]{2,8}_[A-Za-z0-9_-]{8,}/g,
  // Clerk and Stripe style keys (sk_test_..., pk_live_..., whsec_...).
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  // Sentry auth tokens, Firecrawl keys, Daytona keys, Neon passwords.
  /\bsntrys_[A-Za-z0-9_=-]{16,}/g,
  /\bfc-[A-Za-z0-9]{16,}/g,
  /\bdtn_[A-Za-z0-9_-]{12,}/g,
  /\bnpg_[A-Za-z0-9]{8,}/g,
  // GitHub tokens and AWS access key IDs.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Authorization headers.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // Anything://user:password@host (database URLs, URLs with credentials).
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
  // key=value and "key": "value" for names that hold secrets.
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b["']?\s*[:=]\s*["']?[^\s"',;&]{4,}/gi,
]

const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A long run of letters, digits, "_" and "-" that mixes letters and digits is
// almost always a key or token. Plain words, UUIDs and long names made only of
// letters are left alone.
function looksLikeToken(candidate: string) {
  return (
    !UUID.test(candidate) && /[A-Za-z]/.test(candidate) && /\d/.test(candidate)
  )
}

// A string with keys and tokens replaced, cut to `max` characters.
export function scrubString(value: string, max = MAX_STRING_CHARS): string {
  let text =
    value.length > MAX_INPUT_CHARS ? value.slice(0, MAX_INPUT_CHARS) : value

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, REDACTED)
  }
  text = text.replace(LONG_TOKEN, (match) =>
    looksLikeToken(match) ? REDACTED : match
  )

  return text.length > max ? `${text.slice(0, max)}... (cut)` : text
}

// Like scrubString for text that is part of the event's structure (a file
// name in a stack frame, a route): keys are still removed, but long names that
// merely look like tokens stay, because they are how the error is found.
function scrubStructural(value: string) {
  let text =
    value.length > MAX_INPUT_CHARS ? value.slice(0, MAX_INPUT_CHARS) : value
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, REDACTED)
  }
  return text.length > 600 ? `${text.slice(0, 600)}... (cut)` : text
}

// Field names that hold what a person typed or what a tool returned. Compared
// with spaces, dots, dashes and underscores removed, in lower case.
const SENSITIVE_KEYS = new Set([
  "text",
  "content",
  "contents",
  "message",
  "messages",
  "parts",
  "prompt",
  "prompts",
  "system",
  "instructions",
  "completion",
  "memory",
  "memories",
  "memorycontent",
  "notes",
  "input",
  "inputs",
  "output",
  "outputs",
  "toolinput",
  "tooloutput",
  "args",
  "arguments",
  "result",
  "results",
  "body",
  "data",
  "stdout",
  "stderr",
  "command",
  "filecontent",
  "query",
  "querystring",
  "statement",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "credentials",
  "headers",
  "image",
  "screenshot",
])

// Dotted attribute names such as "gen_ai.input.messages" or "db.query.text".
// What matters is the last word.
const SENSITIVE_LAST_WORDS = new Set([
  "messages",
  "message",
  "prompt",
  "completion",
  "input",
  "output",
  "args",
  "arguments",
  "result",
  "text",
  "content",
  "instructions",
  "body",
  "statement",
  "query",
  "stdout",
  "stderr",
  "command",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
])

export function isSensitiveKey(key: string) {
  const squashed = key.toLowerCase().replace(/[\s._-]/g, "")
  if (SENSITIVE_KEYS.has(squashed)) {
    return true
  }
  const last = key.toLowerCase().split(/[\s._-]+/).pop() ?? ""
  return SENSITIVE_LAST_WORDS.has(last)
}

// Names whose text is part of how an error is found, not something a person
// wrote. Only keys and credentials are removed from these.
const STRUCTURAL_KEYS = new Set([
  "filename",
  "abs_path",
  "module",
  "function",
  "type",
  "platform",
  "release",
  "environment",
  "trace_id",
  "span_id",
  "parent_span_id",
  "event_id",
  "op",
  "origin",
  "level",
  "logger",
  "transaction",
  "url",
  "method",
  "name",
  "category",
  "package",
  "version",
])

type Json = Record<string, unknown>

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Cleans anything: sensitive fields are replaced, strings are scrubbed, and
// deep or huge structures are cut. Never returns what it was given.
export function scrubValue(value: unknown, key = "", depth = 0): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === "string") {
    // A bare URL or path loses its query string and fragment: what is after
    // "?" is whatever the caller put there.
    const text = /^(?:https?:\/\/|\/)\S*$/i.test(value)
      ? value.replace(/[?#].*$/, "")
      : value
    return STRUCTURAL_KEYS.has(key)
      ? scrubStructural(stripQuery(text, key))
      : scrubString(text)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => scrubValue(item, key, depth + 1))
  }
  if (isPlainObject(value)) {
    const out: Json = {}
    for (const [name, inner] of Object.entries(value)) {
      out[name] = isSensitiveKey(name)
        ? inner === null || inner === undefined
          ? inner
          : REDACTED
        : scrubValue(inner, name, depth + 1)
    }
    return out
  }
  // Functions, symbols, class instances: nothing we want to send.
  return REDACTED
}

// A URL (or a "GET https://..." description) without its query string and
// fragment: what is after "?" is whatever the caller put there.
function stripQuery(value: string, key: string) {
  if (key !== "url" && key !== "transaction" && key !== "description") {
    return value
  }
  return value.replace(/\?[^\s]*/g, "").replace(/#[^\s]*/g, "")
}

// An error's message, for the event. A message that carries chat or memory
// content is replaced whole: cutting it could still leave someone's words in.
function scrubErrorMessage(value: unknown): string {
  if (typeof value !== "string") {
    return REDACTED
  }
  if (/["']?\b(?:content|text|parts|messages?|prompt)\b["']?\s*:/i.test(value)) {
    return `${REDACTED} (the message carried content)`
  }
  return scrubString(value, 200)
}

// Tags the SDK adds on its own that say where an event came from.
const SDK_TAGS = new Set(["runtime", "runtime.name", "transaction"])

function scrubTags(tags: unknown): Json | undefined {
  if (!isPlainObject(tags)) {
    return undefined
  }

  const out: Json = {}
  for (const [name, value] of Object.entries(tags)) {
    if ((TAG_NAMES as readonly string[]).includes(name)) {
      // Our own IDs: kept exactly when they look like IDs, dropped otherwise.
      if (typeof value === "string" && SAFE_ID.test(value)) {
        out[name] = value
      }
    } else if (SDK_TAGS.has(name) && typeof value === "string") {
      out[name] = scrubStructural(stripQuery(value, "transaction"))
    }
    // Any other tag is dropped: a tag is free text.
  }
  return out
}

// Only the pieces of the context that describe the environment, never the
// request or the user.
const KEPT_CONTEXTS = ["trace", "runtime", "os", "browser", "app"] as const
const KEPT_TRACE_FIELDS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "op",
  "status",
  "origin",
]

function scrubContexts(contexts: unknown): Json | undefined {
  if (!isPlainObject(contexts)) {
    return undefined
  }

  const out: Json = {}
  for (const name of KEPT_CONTEXTS) {
    const context = contexts[name]
    if (!isPlainObject(context)) {
      continue
    }
    if (name === "trace") {
      const trace: Json = {}
      for (const field of KEPT_TRACE_FIELDS) {
        if (context[field] !== undefined) {
          trace[field] = context[field]
        }
      }
      out.trace = scrubValue(trace)
    } else {
      // Names and versions of the runtime, system and browser.
      const small: Json = {}
      for (const field of ["name", "version", "type"]) {
        if (typeof context[field] === "string") {
          small[field] = context[field]
        }
      }
      out[name] = scrubValue(small)
    }
  }
  return out
}

function scrubBreadcrumbs(breadcrumbs: unknown): unknown[] | undefined {
  if (!Array.isArray(breadcrumbs)) {
    return undefined
  }
  // A breadcrumb's message and data are where console output, URLs and
  // request details end up. What is left says that something happened.
  return breadcrumbs.slice(-30).map((crumb) => {
    const source = isPlainObject(crumb) ? crumb : {}
    return {
      type: typeof source.type === "string" ? source.type : undefined,
      category:
        typeof source.category === "string" ? source.category : undefined,
      level: typeof source.level === "string" ? source.level : undefined,
      timestamp:
        typeof source.timestamp === "number" ? source.timestamp : undefined,
    }
  })
}

function scrubException(exception: unknown): unknown {
  if (!isPlainObject(exception) || !Array.isArray(exception.values)) {
    return undefined
  }

  return {
    values: exception.values.slice(0, 10).map((entry) => {
      const source = isPlainObject(entry) ? entry : {}
      const stacktrace = isPlainObject(source.stacktrace)
        ? source.stacktrace
        : null
      const frames = Array.isArray(stacktrace?.frames) ? stacktrace.frames : []

      return {
        type: typeof source.type === "string" ? scrubStructural(source.type) : undefined,
        value: scrubErrorMessage(source.value),
        mechanism: isPlainObject(source.mechanism)
          ? {
              type: source.mechanism.type,
              handled: source.mechanism.handled,
            }
          : undefined,
        stacktrace: {
          // Local variables and source lines are not sent: both can hold
          // whatever the code was working with.
          frames: frames.slice(-60).map((frame) => {
            const f = isPlainObject(frame) ? frame : {}
            return {
              filename: f.filename,
              abs_path: f.abs_path,
              module: f.module,
              function: f.function,
              lineno: f.lineno,
              colno: f.colno,
              in_app: f.in_app,
            }
          }),
        },
      }
    }),
  }
}

// The request the error happened in: which route, not what was sent to it.
function scrubRequest(request: unknown): Json | undefined {
  if (!isPlainObject(request)) {
    return undefined
  }
  const out: Json = {}
  if (typeof request.method === "string") {
    out.method = request.method
  }
  if (typeof request.url === "string") {
    out.url = stripQuery(request.url, "url")
  }
  return scrubValue(out) as Json
}

function scrubUser(user: unknown): Json | undefined {
  if (isPlainObject(user) && typeof user.id === "string" && SAFE_ID.test(user.id)) {
    return { id: user.id }
  }
  return undefined
}

function scrubSpanList(spans: unknown): unknown[] | undefined {
  if (!Array.isArray(spans)) {
    return undefined
  }
  return spans.slice(0, 200).map((span) => scrubSpan(isPlainObject(span) ? span : {}))
}

// Attributes about the person or their machine that the SDK adds on its own.
// None of them helps find a bug in a reply, so none are sent.
const DROPPED_ATTRIBUTE = /^(?:user|client|culture|device|network\.peer)\.|^http\.client_ip$/i

// A span as Sentry sends it. Its name and attributes are cleaned; the timing
// and the IDs that tie it to its trace are kept. Sentry 11 streams spans one by
// one (a name and `attributes`); the older format, where spans travel inside a
// transaction (a description and `data`), is handled the same way.
export function scrubSpan<T extends object>(span: T): T {
  const source = span as Json
  const out: Json = { ...source }

  for (const field of ["name", "description"]) {
    const text = source[field]
    if (typeof text === "string") {
      out[field] = scrubStructural(stripQuery(text, "description"))
    }
  }
  for (const field of ["attributes", "data"]) {
    if (source[field] !== undefined) {
      const clean = scrubValue(source[field], "span_attributes")
      if (isPlainObject(clean)) {
        for (const name of Object.keys(clean)) {
          if (DROPPED_ATTRIBUTE.test(name)) {
            delete clean[name]
          }
        }
      }
      out[field] = clean
    }
  }
  // Links carry attributes of their own and nothing we need.
  delete out.links
  // Tags on a span are limited the same way as on an event.
  if (source.tags !== undefined) {
    out.tags = scrubTags(source.tags)
  }
  return out as T
}

// The whole event. Returns null (drop it) if anything goes wrong while
// cleaning: a failed scrub must never become an unscrubbed send.
export function scrubEvent<T extends object>(event: T): T | null {
  try {
    const source = event as Json
    const out: Json = {}

    // Fields that identify the event or say what kind it is.
    for (const field of [
      "event_id",
      "timestamp",
      "start_timestamp",
      "type",
      "level",
      "platform",
      "environment",
      "release",
      "transaction",
      "transaction_info",
      "sdk",
      "fingerprint",
    ]) {
      if (source[field] !== undefined) {
        out[field] = source[field]
      }
    }

    // A "message" on an event is free text. This app only reports errors, which
    // carry theirs in exception, so anything here is replaced.
    if (typeof source.message === "string") {
      out.message = REDACTED
    }

    out.exception = scrubException(source.exception)
    out.request = scrubRequest(source.request)
    out.user = scrubUser(source.user)
    out.tags = scrubTags(source.tags)
    out.contexts = scrubContexts(source.contexts)
    out.breadcrumbs = scrubBreadcrumbs(source.breadcrumbs)
    out.spans = scrubSpanList(source.spans)
    // Not sent at all: free-form extras, the machine's name, module lists,
    // and anything else not named above.

    for (const [name, value] of Object.entries(out)) {
      if (value === undefined) {
        delete out[name]
      }
    }

    // A final pass over what is left, as a backstop.
    return scrubStructuralPass(out) as T
  } catch {
    return null
  }
}

// The last pass over an already-cleaned event: secret-shaped text anywhere is
// replaced, whatever field it is in.
function scrubStructuralPass(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return scrubStructural(value)
  }
  if (depth >= MAX_DEPTH + 2) {
    return REDACTED
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubStructuralPass(item, depth + 1))
  }
  if (isPlainObject(value)) {
    const out: Json = {}
    for (const [name, inner] of Object.entries(value)) {
      out[name] = scrubStructuralPass(inner, depth + 1)
    }
    return out
  }
  return value
}

// A breadcrumb with only what says that something happened.
export function scrubBreadcrumb<T extends object>(crumb: T): T {
  const [clean] = scrubBreadcrumbs([crumb]) ?? [{}]
  return clean as T
}

// IDs for the four tags, kept only if they look like IDs.
export function cleanTags(tags: Tags): Tags {
  const out: Tags = {}
  for (const name of TAG_NAMES) {
    const value = tags[name]
    if (typeof value === "string" && SAFE_ID.test(value)) {
      out[name] = value
    }
  }
  return out
}
