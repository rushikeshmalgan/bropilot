// The queue that runs bot replies in the background. The app only knows this
// interface; the real one is Trigger.dev, and tests use an in-memory fake.
//
// Written from the Trigger.dev docs that ship with the installed SDK:
// - node_modules/@trigger.dev/sdk/docs/triggering.mdx (tasks.trigger)
// - node_modules/@trigger.dev/sdk/docs/realtime/auth.mdx (auth.createPublicToken)
// - node_modules/@trigger.dev/sdk/docs/runs.mdx (runs.cancel)
import { auth, runs, tasks } from "@trigger.dev/sdk"

import type { executeRunTask } from "@/src/trigger/execute-run"

export type EnqueuedRun = {
  // The queue's own ID for the run.
  externalId: string
}

export interface RunQueue {
  // Hands a saved run to a worker. The worker calls executeRun(runId).
  enqueue(runId: string): Promise<EnqueuedRun>
  // A short-lived token the browser can use to watch this one run, or null if
  // the queue has no live updates (the browser then polls the database).
  createReadToken(externalId: string): Promise<string | null>
  // Stops the worker. The run is already marked cancelled in the database by
  // the time this is called, so it only saves compute.
  cancel(externalId: string): Promise<void>
}

// How long a browser's read token lasts. A run is over well before this.
const READ_TOKEN_LIFETIME = "15m"

export const triggerRunQueue: RunQueue = {
  async enqueue(runId) {
    const handle = await tasks.trigger<typeof executeRunTask>(
      "execute-run",
      { runId },
      // The same run is never queued twice, even if this call is repeated.
      { idempotencyKey: `run-${runId}` }
    )

    return { externalId: handle.id }
  },

  async createReadToken(externalId) {
    // Scoped to this single run: it can't read or change anything else.
    return auth.createPublicToken({
      scopes: { read: { runs: [externalId] } },
      expirationTime: READ_TOKEN_LIFETIME,
    })
  },

  async cancel(externalId) {
    await runs.cancel(externalId)
  },
}
