import { executeRun, type ExecuteRunDeps } from "@/lib/agent/execute-run"
import type { RunQueue } from "@/lib/providers/run-queue"

type Options = {
  // Passed to executeRun: the fake model, shorter delays and so on.
  deps?: ExecuteRunDeps
  // Start each run as soon as it is queued (default). When false, runs wait
  // until runNext() is called, like a queue with no worker.
  autoRun?: boolean
  // Makes enqueue fail, like the queue service being down.
  failEnqueue?: boolean
}

// An in-memory stand-in for Trigger.dev. It runs the same executeRun the real
// task runs, in this process.
export function fakeRunQueue(options: Options = {}) {
  const waiting: string[] = []
  const work: Promise<unknown>[] = []
  const enqueued: string[] = []
  const cancelled: string[] = []
  let count = 0

  const start = (runId: string) => {
    const running = executeRun(runId, options.deps)
    work.push(running.catch(() => {}))
    return running
  }

  const queue: RunQueue = {
    async enqueue(runId) {
      if (options.failEnqueue) {
        throw new Error("The queue is down")
      }

      enqueued.push(runId)
      if (options.autoRun === false) {
        waiting.push(runId)
      } else {
        start(runId)
      }

      return { externalId: `fake_run_${++count}` }
    },
    // No live updates: the browser polls the database.
    async createReadToken() {
      return null
    },
    async cancel(externalId) {
      cancelled.push(externalId)
    },
  }

  return Object.assign(queue, {
    enqueued,
    cancelled,
    // Starts the oldest waiting run and resolves when it has finished.
    runNext() {
      const runId = waiting.shift()
      if (!runId) {
        throw new Error("No run is waiting")
      }
      return start(runId)
    },
    // Resolves when every run that was started has finished.
    settle() {
      return Promise.all(work)
    },
  })
}
