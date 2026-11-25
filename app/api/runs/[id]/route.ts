import { auth } from "@clerk/nextjs/server"

import {
  getRunWithMessage,
  isStaleRun,
  sweepChat,
} from "@/lib/agent/run-store"
import { isActiveRunStatus } from "@/lib/chat-types"
import { checkLimit } from "@/lib/rate-limit"

// Reads of a run a user may make per minute. A reply being watched is read
// about once a second, so this allows several tabs.
const RUN_READ_LIMIT = 300

// Where a run stands, with the reply so far. The browser polls this about once
// a second while a run is unfinished. Only the chat's owner gets an answer;
// for anyone else the run doesn't exist.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) {
    return Response.json(
      { error: "Sign in to chat.", code: "unauthorized" },
      { status: 401 }
    )
  }

  const limit = checkLimit("run-read", userId, RUN_READ_LIMIT, 60_000)
  if (!limit.ok) {
    return Response.json(
      { error: "That's too many requests. Try again in a minute.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    )
  }

  const { id } = await params
  let found =
    typeof id === "string" && id.length <= 64
      ? await getRunWithMessage(userId, id)
      : null

  // A run whose worker died is cleared here too, not only when the chat is
  // opened, so the person watching it gets their "Try again" at the deadline.
  if (found && isActiveRunStatus(found.run.status) && isStaleRun(found.run)) {
    await sweepChat(found.run.chatId)
    found = await getRunWithMessage(userId, id)
  }
  const snapshot = found?.snapshot ?? null

  if (!snapshot) {
    return Response.json(
      { error: "That run doesn't exist.", code: "not_found" },
      { status: 404 }
    )
  }

  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } })
}
