// A bot's desktop: what state it is in, waking it, and the address the owner's
// browser uses to watch it. docs/computer-use.md explains the states and who
// may see what.
//
// Nothing here creates a sandbox. Looking at the screen, or pressing Start,
// only wakes one that already exists; a sandbox is made the first time the bot
// uses a sandbox or computer tool (see lib/sandbox.ts).
import {
  getOrCreateSandbox,
  isPending,
  readSandboxId,
  type SandboxFailure,
} from "@/lib/sandbox"
import { computerRefusal, planLimits, type PlanId } from "@/lib/plans"
import { getSandboxProvider } from "@/lib/providers"
import {
  SandboxProviderError,
  type SandboxProvider,
} from "@/lib/providers/sandbox"

// How long a viewer address works for. The browser asks again whenever it
// connects.
export const VIEWER_URL_SECONDS = 5 * 60
// How long the owner waits for a status check before it counts as unreachable.
const STATUS_TIMEOUT_MS = 6_000

export type DesktopStatus =
  | { configured: false }
  | {
      configured: true
      state: "stopped" | "starting" | "live" | "error" | "deleting"
      // Why it is stopped or in error, in words the screen can show.
      // plan: the user's plan doesn't include a screen
      reason?: "no_sandbox" | "unreachable" | "failed" | "plan"
    }

// The plan is always passed in: a screen is part of the paid plan.
type Deps = { provider?: SandboxProvider | null; plan: PlanId }

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

// Where the bot's desktop stands. Null if the bot isn't the user's. Never
// throws: a provider that can't be reached is reported as an error state.
export async function getDesktopStatus(
  userId: string,
  botId: string,
  deps: Deps
): Promise<DesktopStatus | null> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  const bot = await readSandboxId(userId, botId)
  if (!bot) {
    return null
  }
  if (!provider) {
    return { configured: false }
  }
  if (!planLimits(deps.plan).computerUse) {
    return { configured: true, state: "stopped", reason: "plan" }
  }
  if (!bot.sandboxId) {
    return { configured: true, state: "stopped", reason: "no_sandbox" }
  }
  if (isPending(bot.sandboxId)) {
    return { configured: true, state: "starting" }
  }

  try {
    const sandbox = await withTimeout(
      provider.status(bot.sandboxId),
      STATUS_TIMEOUT_MS
    )

    switch (sandbox) {
      case "missing":
        // Gone at the provider; the next use makes a new one.
        return { configured: true, state: "stopped", reason: "no_sandbox" }
      case "error":
        return { configured: true, state: "error", reason: "failed" }
      case "deleting":
        return { configured: true, state: "deleting" }
      case "stopped":
        return { configured: true, state: "stopped" }
      case "transitioning":
        return { configured: true, state: "starting" }
    }

    // The sandbox is running, so ask the desktop inside it.
    const desktop = await withTimeout(
      provider.desktop.status(bot.sandboxId),
      STATUS_TIMEOUT_MS
    )
    switch (desktop) {
      case "running":
        return { configured: true, state: "live" }
      case "starting":
        return { configured: true, state: "starting" }
      case "error":
        return { configured: true, state: "error", reason: "failed" }
      default:
        return { configured: true, state: "stopped" }
    }
  } catch {
    return { configured: true, state: "error", reason: "unreachable" }
  }
}

export type DesktopConnection = {
  status: DesktopStatus
  // Present only when the desktop is live.
  url?: string
  expiresInSeconds?: number
}

// Wakes the bot's sandbox if it is off, then starts its desktop. Only for a
// sandbox that already exists. Returns the state afterwards.
async function wake(
  provider: SandboxProvider,
  sandboxId: string
): Promise<boolean> {
  try {
    if ((await provider.status(sandboxId)) !== "running") {
      await provider.start(sandboxId)
    }
    await provider.desktop.start(sandboxId)
    return true
  } catch (error) {
    if (!(error instanceof SandboxProviderError)) {
      console.error(
        "Waking the desktop failed:",
        error instanceof Error ? error.name : "unknown error"
      )
    }
    return false
  }
}

// What the owner's browser needs to show the screen: the state, and when it is
// live, a fresh viewer address. With `start`, a stopped desktop is woken first.
// Null if the bot isn't the user's.
export async function connectDesktop(
  userId: string,
  botId: string,
  options: { start?: boolean; control?: boolean } = {},
  deps: Deps
): Promise<DesktopConnection | null> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  let status = await getDesktopStatus(userId, botId, {
    provider,
    plan: deps.plan,
  })
  if (!status) {
    return null
  }
  if (!provider || !status.configured) {
    return { status }
  }

  // Only a plain "off" is woken: not a missing sandbox, and not a plan that
  // doesn't include a screen.
  if (options.start && status.state === "stopped" && !status.reason) {
    const bot = await readSandboxId(userId, botId)
    if (bot?.sandboxId && !isPending(bot.sandboxId)) {
      const woke = await wake(provider, bot.sandboxId)
      status = woke
        ? ((await getDesktopStatus(userId, botId, {
            provider,
            plan: deps.plan,
          })) ?? status)
        : { configured: true, state: "error", reason: "failed" }
    }
  }

  if (status.configured && status.state === "live") {
    const bot = await readSandboxId(userId, botId)
    if (bot?.sandboxId && !isPending(bot.sandboxId)) {
      try {
        const url = await provider.desktop.viewerUrl(bot.sandboxId, {
          expiresInSeconds: VIEWER_URL_SECONDS,
          // View-only unless the owner asked to take control.
          viewOnly: options.control !== true,
        })
        return { status, url, expiresInSeconds: VIEWER_URL_SECONDS }
      } catch {
        return {
          status: { configured: true, state: "error", reason: "failed" },
        }
      }
    }
  }

  return { status }
}

export type DesktopReady =
  | { ok: true; provider: SandboxProvider; sandboxId: string }
  | SandboxFailure

// For the bot's own use: its sandbox (made now if it has none), awake, with
// the desktop running. This is the one place a computer action starts things.
export async function ensureDesktop(
  userId: string,
  botId: string,
  deps: Deps
): Promise<DesktopReady> {
  const provider =
    deps.provider === undefined ? getSandboxProvider() : deps.provider

  if (!planLimits(deps.plan).computerUse) {
    return {
      ok: false,
      code: "plan_limit",
      error: computerRefusal(deps.plan).error,
    }
  }

  const sandbox = await getOrCreateSandbox(userId, botId, {
    provider,
    plan: deps.plan,
  })
  if (!sandbox.ok) {
    return sandbox
  }
  if (!provider) {
    return { ok: false, code: "not_configured", error: "Sandboxes aren't available right now." }
  }

  try {
    const state = await provider.desktop.status(sandbox.sandboxId)
    if (state === "error") {
      return {
        ok: false,
        code: "failed",
        error:
          "The desktop is in an error state. The owner can reset the sandbox from the bot's settings.",
      }
    }
    if (state !== "running") {
      await provider.desktop.start(sandbox.sandboxId)
    }
    return { ok: true, provider, sandboxId: sandbox.sandboxId }
  } catch (error) {
    return {
      ok: false,
      code: "failed",
      error:
        error instanceof SandboxProviderError
          ? error.message
          : "The desktop couldn't be started.",
    }
  }
}
