// A bot's sandbox: created the first time a tool needs it, found again after
// that, and removed when the bot or the owner says so.
//
// bots.sandbox_id is the one record of which sandbox belongs to a bot, and it
// is only ever changed with a compare-and-set (an UPDATE that names the value
// it expects to replace). Creating goes in three steps:
//
//   1. claim:    sandbox_id NULL            -> "pending:<time>:<token>"
//   2. create the sandbox at the provider
//   3. finish:   "pending:<time>:<token>"   -> the sandbox's real ID
//
// Only one caller can win step 1, so two runs starting at once can never
// create two sandboxes. Callers that lose wait for the winner to finish. If
// the winner dies half-way its claim goes stale; the next caller clears it,
// removes any sandbox the dead creator made but never recorded, and starts
// over.
import { and, eq, sql } from "drizzle-orm"
import { nanoid } from "nanoid"

import { db } from "@/lib/db"
import { bots } from "@/lib/db/schema"
import { getSandboxProvider } from "@/lib/providers"
import {
  SandboxProviderError,
  isSandboxMissing,
  type SandboxProvider,
  type SandboxState,
} from "@/lib/providers/sandbox"

// Minutes without activity before a sandbox switches itself off.
export const SANDBOX_AUTO_STOP_MINUTES = 10
// How long creating a sandbox may take at the provider, in seconds.
export const SANDBOX_CREATE_TIMEOUT_SECONDS = 60
// How long a caller waits for another caller's creation before giving up.
export const SANDBOX_WAIT_MS = 75_000
// How long the Sandbox tab waits for the provider before saying "unknown".
export const STATUS_TIMEOUT_MS = 6_000
// A claim older than this is taken to belong to a creator that died.
export const SANDBOX_CLAIM_STALE_MS = 3 * 60_000

const PENDING_PREFIX = "pending:"

export const SANDBOX_NOT_CONFIGURED_MESSAGE =
  "Sandboxes aren't set up on this server yet (DAYTONA_API_KEY is missing)."

export type SandboxFailure = {
  ok: false
  code: "not_configured" | "not_found" | "busy" | "failed"
  // Safe to show the user and the model.
  error: string
}

export type SandboxLookup = { ok: true; sandboxId: string } | SandboxFailure

type Deps = {
  provider?: SandboxProvider | null
  waitMs?: number
  staleMs?: number
  now?: () => number
  pollMs?: number
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isPending(value: string) {
  return value.startsWith(PENDING_PREFIX)
}

function claimAge(value: string, now: number) {
  const time = Number(value.split(":")[1])
  return Number.isFinite(time) ? now - time : Number.POSITIVE_INFINITY
}

function fail(
  code: SandboxFailure["code"],
  error: string
): SandboxFailure {
  return { ok: false, code, error }
}

function ownedBot(userId: string, botId: string) {
  return and(eq(bots.id, botId), eq(bots.userId, userId))
}

// The bot's recorded sandbox value, or undefined if the bot isn't the user's.
export async function readSandboxId(userId: string, botId: string) {
  const [row] = await db
    .select({ sandboxId: bots.sandboxId })
    .from(bots)
    .where(ownedBot(userId, botId))
    .limit(1)

  return row ? { sandboxId: row.sandboxId } : undefined
}

// Changes sandbox_id from `from` to `to` for one of the user's bots. Returns
// whether this caller made the change. `from` null means "currently empty".
async function swap(
  userId: string,
  botId: string,
  from: string | null,
  to: string | null
) {
  const changed = await db
    .update(bots)
    .set({ sandboxId: to })
    .where(
      and(
        ownedBot(userId, botId),
        from === null ? sql`${bots.sandboxId} is null` : eq(bots.sandboxId, from)
      )
    )
    .returning({ id: bots.id })

  return changed.length > 0
}

// Brings a recorded sandbox to the running state.
async function ensureRunning(
  provider: SandboxProvider,
  sandboxId: string
): Promise<"running" | "missing"> {
  const state: SandboxState = await provider.status(sandboxId)
  // One that is on its way out is as good as gone.
  if (state === "missing" || state === "deleting") {
    return "missing"
  }
  if (state === "error") {
    throw new SandboxProviderError(
      "The sandbox is in an error state. The owner can reset it from the bot's settings."
    )
  }

  if (state !== "running") {
    try {
      await provider.start(sandboxId)
    } catch (error) {
      if (isSandboxMissing(error)) {
        return "missing"
      }
      throw error
    }
  }

  return "running"
}

// Removes sandboxes labelled with this bot that were made but never recorded.
// Only called while the bot's sandbox_id holds a stale claim, so nobody else
// can be creating one.
async function removeOrphans(provider: SandboxProvider, botId: string) {
  try {
    for (const id of await provider.findByBot(botId)) {
      await provider.delete(id).catch(() => {})
    }
  } catch {
    // Cleaning up is best effort; the claim is cleared either way.
  }
}

// The ID of the bot's running sandbox, creating one if it has none. `userId`
// must own the bot: for anyone else the bot doesn't exist.
export async function getOrCreateSandbox(
  userId: string,
  botId: string,
  deps: Deps = {}
): Promise<SandboxLookup> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider
  if (!provider) {
    return fail("not_configured", SANDBOX_NOT_CONFIGURED_MESSAGE)
  }

  const now = deps.now ?? Date.now
  const deadline = now() + (deps.waitMs ?? SANDBOX_WAIT_MS)
  const staleMs = deps.staleMs ?? SANDBOX_CLAIM_STALE_MS
  const pollMs = deps.pollMs ?? 700

  try {
    for (;;) {
      const bot = await readSandboxId(userId, botId)
      if (!bot) {
        return fail("not_found", "That bot doesn't exist.")
      }

      const recorded = bot.sandboxId

      // Recorded and real: use it, starting it if it switched itself off.
      if (recorded && !isPending(recorded)) {
        if ((await ensureRunning(provider, recorded)) === "running") {
          return { ok: true, sandboxId: recorded }
        }

        // It was deleted at the provider. Forget it and make a new one.
        await swap(userId, botId, recorded, null)
        continue
      }

      // Someone's creating it. Wait for them, or clear a dead claim.
      if (recorded) {
        if (claimAge(recorded, now()) > staleMs) {
          await removeOrphans(provider, botId)
          await swap(userId, botId, recorded, null)
          continue
        }

        if (now() >= deadline) {
          return fail(
            "busy",
            "The sandbox is still being set up. Try again in a moment."
          )
        }
        await sleep(pollMs)
        continue
      }

      // Nothing recorded: try to be the one that creates it.
      const claim = `${PENDING_PREFIX}${now()}:${nanoid(8)}`
      if (!(await swap(userId, botId, null, claim))) {
        continue
      }

      return await createClaimed(provider, userId, botId, claim)
    }
  } catch (error) {
    return fail("failed", describe(error, "Couldn't get the sandbox ready."))
  }
}

// Step 2 and 3, for the caller that holds the claim.
async function createClaimed(
  provider: SandboxProvider,
  userId: string,
  botId: string,
  claim: string
): Promise<SandboxLookup> {
  let createdId: string | null = null

  try {
    const created = await provider.create({
      botId,
      autoStopMinutes: SANDBOX_AUTO_STOP_MINUTES,
      timeoutSeconds: SANDBOX_CREATE_TIMEOUT_SECONDS,
    })
    createdId = created.id

    // Commands must not run as root. Ask the sandbox who it is instead of
    // trusting a default.
    const who = await provider.exec(created.id, "id -u", { timeoutSeconds: 15 })
    if (who.exitCode !== 0 || who.output.trim() === "0") {
      throw new SandboxProviderError(
        "The sandbox would run as an administrator, so it was removed."
      )
    }

    // The record may have been cleared while we worked (the bot was deleted,
    // or the owner reset it). Then this sandbox is nobody's.
    if (!(await swap(userId, botId, claim, created.id))) {
      await provider.delete(created.id).catch(() => {})
      return fail("failed", "The sandbox was reset while it was being set up.")
    }

    return { ok: true, sandboxId: created.id }
  } catch (error) {
    if (createdId) {
      await provider.delete(createdId).catch(() => {})
    }
    // Let the next caller try instead of waiting out a dead claim.
    await swap(userId, botId, claim, null).catch(() => {})
    return fail("failed", describe(error, "Couldn't create the sandbox."))
  }
}

function describe(error: unknown, fallback: string) {
  if (error instanceof SandboxProviderError) {
    return error.message
  }
  console.error(
    "Sandbox error:",
    error instanceof Error ? error.name : "unknown error"
  )
  return fallback
}

export type SandboxStatus =
  | { configured: false }
  | {
      configured: true
      // none: no sandbox yet; it is made the first time a bot uses one
      state:
        | "none"
        | "running"
        | "stopped"
        | "starting"
        | "deleting"
        | "error"
        | "unknown"
    }

// What the Sandbox tab shows. Never throws: if the provider can't be reached
// the state is "unknown". Null if the bot isn't the user's.
export async function getSandboxStatus(
  userId: string,
  botId: string,
  deps: Deps = {}
): Promise<SandboxStatus | null> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  const bot = await readSandboxId(userId, botId)
  if (!bot) {
    return null
  }
  if (!provider) {
    return { configured: false }
  }
  if (!bot.sandboxId) {
    return { configured: true, state: "none" }
  }
  if (isPending(bot.sandboxId)) {
    return { configured: true, state: "starting" }
  }

  try {
    // The Sandbox tab shouldn't wait on a slow service.
    const state = await Promise.race([
      provider.status(bot.sandboxId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("status check timed out")), STATUS_TIMEOUT_MS)
      ),
    ])
    return {
      configured: true,
      state:
        state === "running"
          ? "running"
          : state === "stopped"
            ? "stopped"
            : state === "transitioning"
              ? "starting"
              : state === "deleting"
                ? "deleting"
                : state === "error"
                  ? "error"
                  : "none",
    }
  } catch {
    return { configured: true, state: "unknown" }
  }
}

// removedId: the sandbox that was deleted at the provider, if there was one.
export type SandboxRemoval = { ok: true; removedId?: string } | SandboxFailure

// Deletes a sandbox at the provider and forgets it. Used by Reset, and by
// deleting a bot (which passes forget: false because the row goes anyway).
async function removeRecorded(
  provider: SandboxProvider | null,
  userId: string,
  botId: string,
  recorded: string,
  forget: boolean
): Promise<SandboxRemoval> {
  if (provider) {
    try {
      await provider.delete(recorded)
    } catch (error) {
      // Already gone is fine. Anything else keeps the record, so the sandbox
      // isn't lost track of.
      if (!isSandboxMissing(error)) {
        return fail(
          "failed",
          describe(error, "Couldn't remove the sandbox. Try again.")
        )
      }
    }
  }

  if (forget) {
    await swap(userId, botId, recorded, null)
  }
  return { ok: true, removedId: recorded }
}

// Throws the bot's sandbox away; the next tool use makes a fresh one. Files
// in it are gone. Does nothing if the bot has none.
export async function resetSandbox(
  userId: string,
  botId: string,
  deps: Deps = {}
): Promise<SandboxRemoval> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? SANDBOX_CLAIM_STALE_MS

  const bot = await readSandboxId(userId, botId)
  if (!bot) {
    return fail("not_found", "That bot doesn't exist.")
  }
  if (!bot.sandboxId) {
    return { ok: true }
  }

  if (isPending(bot.sandboxId)) {
    if (claimAge(bot.sandboxId, now()) <= staleMs) {
      return fail(
        "busy",
        "The sandbox is being set up right now. Try again in a moment."
      )
    }
    // A dead creator's claim: clear it, and anything it left behind.
    if (provider) {
      await removeOrphans(provider, botId)
    }
    await swap(userId, botId, bot.sandboxId, null)
    return { ok: true }
  }

  if (!provider) {
    return fail("not_configured", SANDBOX_NOT_CONFIGURED_MESSAGE)
  }

  const removed = await removeRecorded(provider, userId, botId, bot.sandboxId, true)
  // Callers of a reset only need to know it worked.
  return removed.ok ? { ok: true } : removed
}

// Deletes a bot's sandbox ahead of deleting the bot. If the sandbox can't be
// removed the bot should be kept, so nothing is orphaned silently. When the
// provider isn't configured any more there's nothing to call; the sandbox ID
// is logged so it can be removed by hand.
export async function deleteBotSandbox(
  userId: string,
  botId: string,
  deps: Deps = {}
): Promise<SandboxRemoval> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  const bot = await readSandboxId(userId, botId)
  if (!bot) {
    return fail("not_found", "That bot doesn't exist.")
  }
  if (!bot.sandboxId) {
    return { ok: true }
  }

  if (isPending(bot.sandboxId)) {
    // A creation is under way. Its finishing step finds the bot gone and
    // deletes the sandbox it made.
    if (provider) {
      await removeOrphans(provider, botId)
    }
    return { ok: true }
  }

  if (!provider) {
    console.error(
      `Bot ${botId} is being deleted while sandboxes aren't configured; sandbox ${bot.sandboxId} must be removed by hand.`
    )
    return { ok: true }
  }

  return removeRecorded(provider, userId, botId, bot.sandboxId, false)
}
