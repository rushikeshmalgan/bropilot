// The Trigger.dev task around executeRun: what happens when it fails.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { GENERIC_ERROR_MESSAGE } from "@/lib/ai"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { executeRunTask } from "@/src/trigger/execute-run"

import { fakeRunQueue } from "./fakes/fake-run-queue"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, readChat, send } from "./helpers/runs"

// executeRun fails the way a database outage would, with text in the error
// that must not be kept on the run.
vi.mock("@/lib/agent/execute-run", () => ({
  executeRun: async () => {
    throw new Error("connection reset while saving MY SECRET TEXT")
  },
}))
vi.mock("@trigger.dev/sdk", () => ({
  task: (definition: unknown) => definition,
  metadata: { set: () => {}, flush: async () => {} },
}))

type Task = {
  run: (
    payload: { runId: string },
    params?: { ctx: { attempt: { number: number } } }
  ) => Promise<unknown>
}
const task = executeRunTask as unknown as Task

describe("the execute-run task when executeRun throws", () => {
  const userId = testUserId()
  let botId = ""

  beforeAll(async () => {
    botId = (await createTestBot(userId)).id
  })
  afterEach(() => resetProviderOverrides())
  afterAll(() => cleanupUser(userId))

  async function queuedRun() {
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, botId)
    const { run } = await send(userId, chatId, "Hello")
    return { chatId, runId: run.runId }
  }

  it("leaves the run for the next attempt after the first failure, and says nothing about the cause", async () => {
    const { chatId, runId } = await queuedRun()

    const failure = await task
      .run({ runId }, { ctx: { attempt: { number: 1 } } })
      .catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("The reply could not be produced.")
    expect((failure as Error).message).not.toContain("SECRET")

    // Trigger.dev will try again, so nothing is marked failed yet.
    const state = await readChat(chatId)
    expect(state.runs[0].status).toBe("queued")
    expect(state.replies).toHaveLength(0)
  })

  it("fails the run, with something the user can retry, after the last attempt", async () => {
    const { chatId, runId } = await queuedRun()

    await expect(
      task.run({ runId }, { ctx: { attempt: { number: 2 } } })
    ).rejects.toThrow("The reply could not be produced.")

    const state = await readChat(chatId)
    expect(state.runs[0]).toMatchObject({ status: "error", error: GENERIC_ERROR_MESSAGE })
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].status).toBe("error")
    expect(JSON.stringify(state.replies[0].parts)).not.toContain("SECRET")
  })

  it("copes with a run that no longer exists", async () => {
    await expect(
      task.run({ runId: "no_such_run" }, { ctx: { attempt: { number: 2 } } })
    ).rejects.toThrow("The reply could not be produced.")
  })
})
