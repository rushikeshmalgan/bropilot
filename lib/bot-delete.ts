// Deleting a bot takes everything that belongs to it with it: its chats and
// messages, its memory (the database does that), and its sandbox (this does).
import { and, eq } from "drizzle-orm"

import { cancelActiveRunsForBot } from "@/lib/agent/run-store"
import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"
import { deleteBotSandbox } from "@/lib/sandbox"
import { getSandboxProvider } from "@/lib/providers"
import type { SandboxProvider } from "@/lib/providers/sandbox"

export type RemoveBotResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "failed"; error: string }

export async function removeBot(
  userId: string,
  botId: string,
  deps: { provider?: SandboxProvider | null } = {}
): Promise<RemoveBotResult> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  // Replies being written for this bot stop first, so no worker keeps going
  // for a bot that is about to be gone.
  await cancelActiveRunsForBot(userId, botId)

  // The sandbox goes before the bot. If it can't be removed the bot is kept,
  // so a sandbox is never left running with nothing pointing at it.
  const sandbox = await deleteBotSandbox(userId, botId, { provider })
  if (!sandbox.ok) {
    return {
      ok: false,
      code: sandbox.code === "not_found" ? "not_found" : "failed",
      error: sandbox.error,
    }
  }

  const [removed] = await db
    .delete(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .returning({ sandboxId: bots.sandboxId })

  if (!removed) {
    return { ok: false, code: "not_found", error: "That bot doesn't exist." }
  }

  // A run may have made a sandbox between the two steps above. If so the row
  // held its ID when it was deleted; remove that one too.
  if (
    removed.sandboxId &&
    removed.sandboxId !== sandbox.removedId &&
    !removed.sandboxId.startsWith("pending:") &&
    provider
  ) {
    await provider.delete(removed.sandboxId).catch((error) => {
      console.error(
        `Sandbox ${removed.sandboxId} of deleted bot ${botId} couldn't be removed:`,
        error instanceof Error ? error.name : "unknown error"
      )
    })
  }

  return { ok: true }
}
