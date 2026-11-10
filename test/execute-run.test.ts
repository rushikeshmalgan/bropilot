import { eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import {
  BUSY_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  RUN_TIMEOUT_MESSAGE,
  classifyModelError,
} from "@/lib/ai"
import { executeRun } from "@/lib/agent/execute-run"
import { cancelRun, getRunSnapshot, sweepChat } from "@/lib/agent/run-store"
import { deleteChat } from "@/lib/actions"
import { selectChat } from "@/lib/chat-store"
import { textOfParts } from "@/lib/chat-types"
import { db } from "@/lib/db"
import { messages, runs, type Bot } from "@/lib/db/schema"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"

import { FAKE_STEP_USAGE, apiError, fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, readChat, send, until, wait } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

// Short but real waits between retries.
const FAST = { retryBaseMs: 40, progressIntervalMs: 60 }

describe("executeRun", () => {
  // Several users, because sends are rate limited per user.
  const users = [testUserId(), testUserId(), testUserId(), testUserId()]
  const botOf = new Map<string, Bot>()
  let next = 0

  // A fresh chat, spread across the users.
  async function chatFor() {
    const userId = users[next++ % users.length]
    const chatId = await newChat(userId, botOf.get(userId)!.id)
    return { userId, chatId }
  }

  beforeAll(async () => {
    for (const userId of users) {
      botOf.set(userId, await createTestBot(userId))
    }
  })

  afterEach(() => {
    resetProviderOverrides()
    signOut()
  })

  afterAll(async () => {
    await Promise.all(users.map(cleanupUser))
  })

  it("writes the reply, its usage and the run's status", async () => {
    const { userId, chatId } = await chatFor()
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })

    const { run, userMessageId } = await send(userId, chatId, "What is 2 + 2?")
    let state = await readChat(chatId)
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      id: run.runId,
      status: "queued",
      userMessageId,
      assistantMessageId: run.assistantMessageId,
      triggerRunId: "fake_run_1",
    })
    // The reply's row doesn't exist until the run starts.
    expect(state.replies).toHaveLength(0)

    const model = fakeModel([{ text: ["Four", ", obviously."] }])
    const result = await executeRun(run.runId, { ...FAST, model })

    expect(result).toEqual({ status: "done" })
    state = await readChat(chatId)
    expect(state.runs[0].status).toBe("done")
    expect(state.runs[0].startedAt).toBeInstanceOf(Date)
    expect(state.runs[0].finishedAt).toBeInstanceOf(Date)
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0]).toMatchObject({
      id: run.assistantMessageId,
      status: "done",
      usage: FAKE_STEP_USAGE,
    })
    expect(state.replyText).toBe("Four, obviously.")
    // A one-on-one chat is named after its first message.
    expect((await selectChat(userId, chatId))?.title).toBe("What is 2 + 2?")
  })

  it("sends the bot's persona and the saved history to the model", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })

    const first = await send(userId, chatId, "My name is Rushi.")
    await executeRun(first.run.runId, {
      ...FAST,
      model: fakeModel([{ text: ["Nice to meet you."] }]),
    })

    const second = await send(userId, chatId, "What is my name?")
    const model = fakeModel([{ text: ["Rushi."] }])
    await executeRun(second.run.runId, { ...FAST, model })

    const prompt = JSON.stringify(model.doStreamCalls[0].prompt)
    expect(prompt).toContain("You are Testbot")
    expect(prompt).toContain("My name is Rushi.")
    expect(prompt).toContain("Nice to meet you.")
    expect(prompt).toContain("What is my name?")
  })

  it("is idempotent: a repeat or a retry never adds a second reply", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    await executeRun(run.runId, { ...FAST, model: fakeModel([{ text: ["One"] }]) })

    // Called again after finishing: nothing changes and the model isn't asked.
    const again = fakeModel([{ text: ["Two"] }])
    expect(await executeRun(run.runId, { ...FAST, model: again })).toEqual({
      status: "done",
    })
    expect(again.callCount()).toBe(0)
    expect((await readChat(chatId)).replyText).toBe("One")

    // A worker that died after saving part of the reply: the run is still
    // "running" with half a message. The retry rewrites that same message.
    await db.batch([
      db
        .update(runs)
        .set({ status: "running", finishedAt: null })
        .where(eq(runs.id, run.runId)),
      db
        .update(messages)
        .set({ status: "streaming", parts: [{ type: "text", text: "Tw" }] })
        .where(eq(messages.id, run.assistantMessageId)),
    ])

    await executeRun(run.runId, { ...FAST, model: fakeModel([{ text: ["Two"] }]) })

    const state = await readChat(chatId)
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].id).toBe(run.assistantMessageId)
    expect(state.replies[0].status).toBe("done")
    expect(state.replyText).toBe("Two")
  })

  it("backs off and retries a 429, then succeeds", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const model = fakeModel([
      { error: apiError(429) },
      { error: apiError(429) },
      { text: ["Third time lucky"] },
    ])
    const startedAt = Date.now()
    const result = await executeRun(run.runId, { ...FAST, model })

    expect(result.status).toBe("done")
    expect(model.callCount()).toBe(3)
    // Real delays: the base, then twice the base.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40 + 80)
    expect((await readChat(chatId)).replyText).toBe("Third time lucky")
  })

  it("gives up after three 429s with the busy message", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const model = fakeModel([{ error: apiError(429) }])
    const result = await executeRun(run.runId, { ...FAST, model })

    expect(result.status).toBe("error")
    expect(model.callCount()).toBe(3)
    const state = await readChat(chatId)
    expect(state.runs[0]).toMatchObject({ status: "error", error: BUSY_MESSAGE })
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].status).toBe("error")
    expect(state.replyText).toBe(BUSY_MESSAGE)
  })

  it("does not retry other 4xx errors", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const model = fakeModel([{ error: apiError(400) }, { text: ["never"] }])
    const result = await executeRun(run.runId, { ...FAST, model })

    expect(result.status).toBe("error")
    expect(model.callCount()).toBe(1)
    expect((await readChat(chatId)).replyText).toBe(GENERIC_ERROR_MESSAGE)
  })

  it("retries a network error once, and only once", async () => {
    const network = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      })

    const first = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const recovered = await send(first.userId, first.chatId)
    const recovering = fakeModel([{ error: network() }, { text: ["Back"] }])
    expect(
      (await executeRun(recovered.run.runId, { ...FAST, model: recovering }))
        .status
    ).toBe("done")
    expect(recovering.callCount()).toBe(2)

    const second = await chatFor()
    const failed = await send(second.userId, second.chatId)
    const failing = fakeModel([{ error: network() }])
    expect(
      (await executeRun(failed.run.runId, { ...FAST, model: failing })).status
    ).toBe("error")
    expect(failing.callCount()).toBe(2)
  })

  it("starts the reply again after a failure part-way through", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const model = fakeModel([
      { text: ["Half an ans"], errorAfterText: apiError(503) },
      { text: ["A whole answer"] },
    ])
    await executeRun(run.runId, { ...FAST, model })

    // The half reply from the failed try is gone, not glued to the new one.
    expect((await readChat(chatId)).replyText).toBe("A whole answer")
  })

  it("treats an empty reply as a failure", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const result = await executeRun(run.runId, { ...FAST, model: fakeModel([{}]) })

    expect(result.status).toBe("error")
    expect((await readChat(chatId)).replyText).toBe(GENERIC_ERROR_MESSAGE)
  })

  it("stops when the run takes longer than the maximum", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    const slow = fakeModel([
      { text: Array.from({ length: 40 }, () => "word "), chunkDelayMs: 100 },
    ])
    const result = await executeRun(run.runId, {
      ...FAST,
      model: slow,
      maxDurationMs: 500,
    })

    expect(result.status).toBe("error")
    const state = await readChat(chatId)
    expect(state.runs[0].error).toBe(RUN_TIMEOUT_MESSAGE)
    expect(state.replyText).toBe(RUN_TIMEOUT_MESSAGE)
  })

  it("Stop keeps the text that arrived and nothing is written afterwards", async () => {
    const { userId, chatId } = await chatFor()
    const slow = fakeModel([
      { text: Array.from({ length: 600 }, (_, i) => `w${i} `), chunkDelayMs: 100 },
    ])
    const queue = fakeRunQueue({ deps: { ...FAST, model: slow } })
    overrideProviders({ runQueue: queue })

    const { run } = await send(userId, chatId)
    // Wait until some of the reply has been saved.
    await until(async () => {
      const snapshot = await getRunSnapshot(userId, run.runId)
      return snapshot?.message && textOfParts(snapshot.message.parts).length > 0
    })

    const stopped = await cancelRun(userId, run.runId)
    expect(stopped?.status).toBe("cancelled")
    expect(stopped?.message?.status).toBe("done")
    const kept = textOfParts(stopped!.message!.parts)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(600 * 4)
    // The queue was told to stop the worker.
    expect(queue.cancelled).toEqual(["fake_run_1"])

    // The worker notices and stops; what it had not saved yet is not added.
    await queue.settle()
    const state = await readChat(chatId)
    expect(state.runs[0].status).toBe("cancelled")
    expect(state.replies).toHaveLength(1)
    expect(state.replyText).toBe(kept)
    expect(slow.callCount()).toBe(1)
  })

  it("Stop before the run starts leaves no reply, and the run never runs", async () => {
    const { userId, chatId } = await chatFor()
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })
    const { run } = await send(userId, chatId)

    const stopped = await cancelRun(userId, run.runId)
    expect(stopped).toMatchObject({ status: "cancelled", message: null })

    const model = fakeModel([{ text: ["too late"] }])
    expect(await executeRun(run.runId, { ...FAST, model })).toEqual({
      status: "cancelled",
    })
    expect(model.callCount()).toBe(0)
    expect((await readChat(chatId)).replies).toHaveLength(0)
  })

  it("Stop after the run finished changes nothing", async () => {
    const { userId, chatId } = await chatFor()
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })
    const { run } = await send(userId, chatId)
    await executeRun(run.runId, { ...FAST, model: fakeModel([{ text: ["Done"] }]) })

    const stopped = await cancelRun(userId, run.runId)

    expect(stopped?.status).toBe("done")
    expect(textOfParts(stopped!.message!.parts)).toBe("Done")
    expect(queue.cancelled).toEqual([])
  })

  it("Stop racing with completion ends in exactly one consistent state", async () => {
    const { userId, chatId } = await chatFor()
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })
    const { run } = await send(userId, chatId)

    // Fire Stop while the run is finishing.
    const [result] = await Promise.all([
      executeRun(run.runId, { ...FAST, model: fakeModel([{ text: ["Answer"] }]) }),
      wait(600).then(() => cancelRun(userId, run.runId)),
    ])

    const state = await readChat(chatId)
    const status = state.runs[0].status
    expect(["done", "cancelled"]).toContain(status)
    expect(result.status).toBe(status)
    if (status === "done") {
      expect(state.replies[0].status).toBe("done")
      expect(state.replyText).toBe("Answer")
    } else {
      // Cancelled: whatever is there is closed, never left "streaming".
      expect(state.replies.every((reply) => reply.status === "done")).toBe(true)
    }
  })

  it("only the owner can stop a run", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    expect(await cancelRun(testUserId(), run.runId)).toBeNull()
    expect((await readChat(chatId)).runs[0].status).toBe("queued")
  })

  it("marks a stuck run as failed and frees the chat", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    // A worker took the run ten minutes ago and was never heard from again.
    await db
      .update(runs)
      .set({
        status: "running",
        startedAt: sql`now() - interval '10 minutes'`,
      })
      .where(eq(runs.id, run.runId))
    await db.insert(messages).values({
      id: run.assistantMessageId,
      chatId,
      role: "assistant",
      botId: botOf.get(userId)!.id,
      parts: [{ type: "text", text: "I was about to say" }],
      status: "streaming",
    })

    await sweepChat(chatId)

    let state = await readChat(chatId)
    expect(state.runs[0]).toMatchObject({
      status: "error",
      error: RUN_TIMEOUT_MESSAGE,
    })
    expect(state.replies[0].status).toBe("error")
    expect(state.replyText).toBe(RUN_TIMEOUT_MESSAGE)

    // A late worker can't bring it back.
    const late = fakeModel([{ text: ["late"] }])
    expect((await executeRun(run.runId, { ...FAST, model: late })).status).toBe(
      "error"
    )
    expect(late.callCount()).toBe(0)

    // The chat accepts a new message.
    const again = await send(userId, chatId, "Still there?")
    await executeRun(again.run.runId, {
      ...FAST,
      model: fakeModel([{ text: ["Yes"] }]),
    })
    state = await readChat(chatId)
    expect(state.runs.map((item) => item.status).sort()).toEqual([
      "done",
      "error",
    ])
  })

  it("a stuck run is cleared by the next send without opening the chat", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)
    await db
      .update(runs)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(runs.id, run.runId))

    const again = await send(userId, chatId, "Hello again")

    const state = await readChat(chatId)
    const byId = new Map(state.runs.map((item) => [item.id, item.status]))
    expect(byId.get(run.runId)).toBe("error")
    expect(byId.get(again.run.runId)).toBe("queued")
  })

  it("leaves a healthy run alone when the chat is swept", async () => {
    const { userId, chatId } = await chatFor()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { run } = await send(userId, chatId)

    await sweepChat(chatId)

    expect((await readChat(chatId)).runs[0]).toMatchObject({
      id: run.runId,
      status: "queued",
    })
  })

  it("deleting a chat stops its run, and the worker ends quietly", async () => {
    const { userId, chatId } = await chatFor()
    const slow = fakeModel([
      { text: Array.from({ length: 600 }, () => "word "), chunkDelayMs: 100 },
    ])
    const queue = fakeRunQueue({ deps: { ...FAST, model: slow } })
    overrideProviders({ runQueue: queue })
    const { run } = await send(userId, chatId)
    await until(async () => (await getRunSnapshot(userId, run.runId))?.message)

    signInAs(userId)
    expect(await deleteChat(chatId)).toEqual({ ok: true })

    expect(queue.cancelled).toEqual(["fake_run_1"])
    // The worker finds nothing left to write to and stops without throwing.
    await expect(queue.settle()).resolves.toBeDefined()
    expect(await selectChat(userId, chatId)).toBeNull()
    expect((await readChat(chatId)).runs).toHaveLength(0)
  })

  it("answers as the mentioned bot in a group chat", async () => {
    const userId = users[0]
    const ada = botOf.get(userId)!
    const ann = await createTestBot(userId, { name: "Ann" })
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const { insertChat } = await import("@/lib/chat-store")
    const chatId = (await insertChat(userId, {
      botIds: [ada.id, ann.id],
      title: "Group",
      group: true,
    }))!

    const { run } = await send(userId, chatId, "@Ann are you there?")
    const model = fakeModel([{ text: ["Here."] }])
    await executeRun(run.runId, { ...FAST, model })

    const state = await readChat(chatId)
    expect(state.runs[0].botId).toBe(ann.id)
    expect(state.replies[0].botId).toBe(ann.id)
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "You are Ann"
    )
  })

  it("does nothing for a run that doesn't exist", async () => {
    expect(await executeRun("no-such-run")).toEqual({ status: "missing" })
    expect(await executeRun("")).toEqual({ status: "missing" })
  })
})

describe("classifyModelError", () => {
  it("sorts errors into retry policies", () => {
    expect(classifyModelError(apiError(429))).toBe("rate_limit")
    expect(classifyModelError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe(
      "rate_limit"
    )
    expect(classifyModelError(apiError(400))).toBe("fatal")
    expect(classifyModelError(apiError(401))).toBe("fatal")
    expect(classifyModelError(apiError(404))).toBe("fatal")
    expect(classifyModelError(apiError(503))).toBe("retry_once")
    expect(classifyModelError(new TypeError("fetch failed"))).toBe("retry_once")
    expect(
      classifyModelError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))
    ).toBe("retry_once")
    expect(classifyModelError(new Error("something odd"))).toBe("fatal")
    // A 429 wrapped by the SDK's retry error is still a 429.
    expect(
      classifyModelError({ message: "failed", lastError: apiError(429) })
    ).toBe("rate_limit")
  })
})
