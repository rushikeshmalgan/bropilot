import { auth } from "@clerk/nextjs/server"

import { replyToMessage } from "@/lib/chat-reply"

// Replies stream, so allow time for a long one.
export const maxDuration = 60

function fail(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status })
}

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

  // The browser sends the chat's ID and only the newest message; the earlier
  // ones are loaded from the database so they can't be forged.
  const { id, message } = (body ?? {}) as {
    id?: unknown
    message?: { role?: unknown; parts?: unknown }
  }

  if (
    typeof id !== "string" ||
    !id ||
    message?.role !== "user" ||
    !Array.isArray(message.parts)
  ) {
    return fail(400, "bad_request", "That request wasn't valid.")
  }

  const text = message.parts
    .map((part: unknown) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    )
    .join("")

  return replyToMessage({ userId, chatId: id, text })
}
