import { metadata, task } from "@trigger.dev/sdk"

import { MAX_RUN_DURATION_MS } from "@/lib/ai"
import { executeRun } from "@/lib/agent/execute-run"
import type { RunProgress } from "@/lib/chat-types"

// Run metadata can hold 256 KB. A reply is far smaller, but if it ever isn't,
// the browser is told to read the database instead.
const MAX_LIVE_BYTES = 100_000

// Produces one bot reply. All of the logic is in executeRun; this only gives it
// a durable place to run and publishes its progress for live updates.
export const executeRunTask = task({
  id: "execute-run",
  // CPU seconds, with room to spare: executeRun enforces the real limit on
  // wall-clock time itself.
  maxDuration: Math.ceil(MAX_RUN_DURATION_MS / 1000) + 60,
  // If the worker crashes, try once more. executeRun is safe to repeat.
  retry: { maxAttempts: 2 },
  run: async (payload: { runId: string }) => {
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
  },
})
