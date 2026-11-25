import { metadata, task } from "@trigger.dev/sdk"

import { GENERIC_ERROR_MESSAGE, MAX_RUN_DURATION_MS } from "@/lib/ai"
import { executeRun } from "@/lib/agent/execute-run"
import { failRunById } from "@/lib/agent/run-store"
import type { RunProgress } from "@/lib/chat-types"
import { flushTelemetry, initWorkerTelemetry } from "@/lib/observability"

// Run metadata can hold 256 KB. A reply is far smaller, but if it ever isn't,
// the browser is told to read the database instead.
const MAX_LIVE_BYTES = 100_000

// How many times Trigger.dev runs the task for one reply if it keeps failing.
const MAX_ATTEMPTS = 2

// Produces one bot reply. All of the logic is in executeRun; this only gives it
// a durable place to run and publishes its progress for live updates.
export const executeRunTask = task({
  id: "execute-run",
  // CPU seconds, with room to spare: executeRun enforces the real limit on
  // wall-clock time itself.
  maxDuration: Math.ceil(MAX_RUN_DURATION_MS / 1000) + 60,
  // If the worker crashes, try once more. executeRun is safe to repeat.
  retry: { maxAttempts: MAX_ATTEMPTS },
  run: async (payload: { runId: string }, params) => {
    // The worker is not part of the Next.js app, so Sentry is started here
    // (it does nothing without SENTRY_DSN in the worker's environment).
    await initWorkerTelemetry()

    try {
      const result = await executeRun(payload.runId, {
        onProgress: (progress: RunProgress) => {
          // Through JSON and back, so only plain data is published: tool input
          // and output are whatever the model and the tools produced.
          const serialized = JSON.stringify(progress)
          metadata.set(
            "progress",
            serialized.length <= MAX_LIVE_BYTES
              ? JSON.parse(serialized)
              : { seq: progress.seq }
          )
        },
      })

      // Make sure the last update is sent before the task exits.
      await metadata.flush()

      return result
    } catch (error) {
      // The browser can read a run's error through its read token, so the
      // error that is kept on the run says nothing about what went wrong. The
      // details are in the worker's log and in Sentry (executeRun reported it).
      console.error(
        "execute-run failed:",
        error instanceof Error ? error.name : "unknown error"
      )
      // Nothing will try again after the last attempt: the reply is marked
      // failed now, so the user sees a "Try again" instead of waiting for the
      // stuck-run sweep (about five minutes).
      if ((params?.ctx?.attempt?.number ?? 1) >= MAX_ATTEMPTS) {
        await failRunById(payload.runId, GENERIC_ERROR_MESSAGE).catch(() => {})
      }
      throw new Error("The reply could not be produced.")
    } finally {
      // The worker can be shut down as soon as the task returns, which would
      // lose events from the end of the run (including a crash's own report).
      await flushTelemetry()
    }
  },
})
