import { auth } from "@clerk/nextjs/server"

import { startRun } from "@/lib/agent/start-run"
import { getPlan } from "@/lib/billing"

function fail(
  status: number,
  code: string,
  error: string,
  headers?: HeadersInit,
  upgrade?: boolean
) {
  return Response.json(
    { error, code, ...(upgrade ? { upgrade: true } : {}) },
    { status, headers }
  )
}

// Saves the user's message and starts the bot's reply as a background run.
// The reply itself isn't in this response: the browser follows the run by its
// ID (see /api/runs/[id]).
export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) {
    return fail(401, "unauthorized", "Sign in to chat.")
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail(400, "bad_request", "That request wasn't valid.")
  }

  // Only the chat's ID and either the new text or the ID of the last message
  // to answer again (after a failed reply) are accepted. Everything else the
  // reply needs is loaded from the database, so it can't be forged.
  const { id, text, retryOf } = (body ?? {}) as {
    id?: unknown
    text?: unknown
    retryOf?: unknown
  }
  const validId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 64
  const retrying = retryOf !== undefined
  if (
    !validId(id) ||
    (retrying ? !validId(retryOf) : typeof text !== "string")
  ) {
    return fail(400, "bad_request", "That request wasn't valid.")
  }

  const result = await startRun({
    userId,
    chatId: id,
    ...(retrying ? { retryOf: retryOf as string } : { text: text as string }),
    // Read from the session here, because the background worker has none.
    plan: await getPlan(userId),
  })
  if (!result.ok) {
    return fail(
      result.status,
      result.code,
      result.error,
      result.retryAfterSeconds
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined,
      result.upgrade
    )
  }

  return Response.json({ run: result.run, userMessageId: result.userMessageId })
}
