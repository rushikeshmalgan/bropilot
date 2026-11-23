import { auth } from "@clerk/nextjs/server"

import { connectDesktop, getDesktopStatus } from "@/lib/desktop"
import { checkLimit } from "@/lib/rate-limit"

// Starting a desktop can take a while.
export const maxDuration = 60

// Viewer addresses a user may ask for, per minute.
export const SCREEN_URL_LIMIT = 20
const SCREEN_URL_WINDOW_MS = 60_000

const NO_STORE = { "Cache-Control": "no-store" }

function reply(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

// What the browser is told about a desktop. The bot's sandbox is never named
// here: only a state and, when the screen is live, an address that expires.
function present(
  status: Awaited<ReturnType<typeof getDesktopStatus>>,
  extra: { url?: string; expiresInSeconds?: number } = {}
) {
  if (!status || !status.configured) {
    return { configured: false }
  }

  return {
    configured: true,
    state: status.state,
    ...(status.reason ? { reason: status.reason } : {}),
    ...extra,
  }
}

async function ownerOf(params: Promise<{ id: string }>) {
  const { userId } = await auth()
  if (!userId) {
    return { response: reply({ error: "Sign in to see the screen.", code: "unauthorized" }, 401) }
  }

  const { id } = await params
  if (typeof id !== "string" || !id || id.length > 64) {
    return { response: reply({ error: "That bot doesn't exist.", code: "not_found" }, 404) }
  }

  return { userId, botId: id }
}

// Where the bot's screen stands. No address: this is what the viewer asks
// every few seconds.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const owner = await ownerOf(params)
  if (owner.response) {
    return owner.response
  }

  const status = await getDesktopStatus(owner.userId, owner.botId)
  if (!status) {
    return reply({ error: "That bot doesn't exist.", code: "not_found" }, 404)
  }

  return reply(present(status))
}

// Opens the screen: its state and, when it is live, a fresh address that
// shows it. { start: true } wakes a stopped one (it never creates a sandbox),
// { control: true } asks for an address that isn't view-only.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const owner = await ownerOf(params)
  if (owner.response) {
    return owner.response
  }

  const limit = checkLimit(
    "screen",
    owner.userId,
    SCREEN_URL_LIMIT,
    SCREEN_URL_WINDOW_MS
  )
  if (!limit.ok) {
    return reply(
      { error: "That's too many screen requests. Try again in a minute.", code: "rate_limited" },
      429,
      { "Retry-After": String(limit.retryAfterSeconds) }
    )
  }

  let body: { start?: unknown; control?: unknown } = {}
  try {
    const text = await request.text()
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as typeof body
      } else {
        return reply({ error: "That request wasn't valid.", code: "bad_request" }, 400)
      }
    }
  } catch {
    return reply({ error: "That request wasn't valid.", code: "bad_request" }, 400)
  }

  const connection = await connectDesktop(owner.userId, owner.botId, {
    start: body.start === true,
    control: body.control === true,
  })
  if (!connection) {
    return reply({ error: "That bot doesn't exist.", code: "not_found" }, 404)
  }

  return reply(
    present(connection.status, {
      url: connection.url,
      expiresInSeconds: connection.expiresInSeconds,
    })
  )
}
