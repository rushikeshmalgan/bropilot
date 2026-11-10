// How the browser follows a run until it finishes. This is the one interface
// the chat screen uses for progress. It reads the database through an
// ownership-checked route about once a second; when Trigger.dev live updates
// are available they fill in the text between reads, and this loop still
// decides when the run is over, so what ends up on screen is always the saved
// row. No React or DOM in here, so it can be tested directly.
import {
  isActiveRunStatus,
  type RunProgress,
  type RunSnapshot,
} from "@/lib/chat-types"

// Reads a run's state. Returns null when the run doesn't exist for this user
// (deleted, or not theirs). Throws on a network or server failure.
export type FetchSnapshot = (runId: string) => Promise<RunSnapshot | null>

export const POLL_INTERVAL_MS = 1000
// With live updates working, the database only needs checking now and then.
export const POLL_INTERVAL_WITH_LIVE_MS = 3000

export type FollowRunOptions = {
  runId: string
  fetchSnapshot: FetchSnapshot
  // Called with every state read while the run is unfinished, and exactly once
  // with the final one.
  onSnapshot: (snapshot: RunSnapshot) => void
  // The run no longer exists (its chat was deleted).
  onGone?: () => void
  // Lets the caller slow the loop down while live updates are healthy.
  intervalMs?: () => number
}

export type RunFollower = {
  stop: () => void
  // Read the state now instead of waiting for the next turn.
  poke: () => void
}

export function followRun({
  runId,
  fetchSnapshot,
  onSnapshot,
  onGone,
  intervalMs = () => POLL_INTERVAL_MS,
}: FollowRunOptions): RunFollower {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let pokedWhileReading = false

  const schedule = (delay: number) => {
    if (stopped) {
      return
    }
    timer = setTimeout(read, delay)
  }

  async function read() {
    if (stopped || reading) {
      return
    }
    reading = true
    timer = null

    try {
      const snapshot = await fetchSnapshot(runId)
      if (stopped) {
        return
      }

      if (!snapshot) {
        stopped = true
        onGone?.()
        return
      }

      onSnapshot(snapshot)
      if (!isActiveRunStatus(snapshot.status)) {
        stopped = true
        return
      }
    } catch {
      // The network dropped or the server hiccuped. Keep trying: the run goes
      // on without us, and the next read catches up.
    } finally {
      reading = false
    }

    if (pokedWhileReading) {
      pokedWhileReading = false
      schedule(0)
    } else {
      schedule(intervalMs())
    }
  }

  schedule(0)

  return {
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    },
    poke() {
      if (stopped) {
        return
      }
      if (reading) {
        pokedWhileReading = true
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      schedule(0)
    },
  }
}

// Reads a live update published by the worker. Returns null for anything that
// isn't a well-formed, newer update, so a stray or late one can't put older
// text back on screen.
export function readLiveProgress(
  value: unknown,
  lastSeq: number
): RunProgress | { seq: number; parts: null } | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const { seq, parts } = value as { seq?: unknown; parts?: unknown }
  if (typeof seq !== "number" || seq <= lastSeq) {
    return null
  }
  // Too large to send live: the caller reads the database instead.
  if (parts === undefined) {
    return { seq, parts: null }
  }
  if (!Array.isArray(parts)) {
    return null
  }

  return { seq, parts: parts as RunProgress["parts"] }
}

// The browser's reader: the ownership-checked route.
export const fetchRunSnapshot: FetchSnapshot = async (runId) => {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
    cache: "no-store",
  })

  if (response.status === 404 || response.status === 401) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Run state request failed (${response.status})`)
  }

  return (await response.json()) as RunSnapshot
}
