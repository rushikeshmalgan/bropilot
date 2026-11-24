// "Try again" on a failed reply: the same message is answered again and the
// failed reply is replaced. Nothing else can be retried.
import { eq } from "drizzle-orm"
import { afterAll, afterEach, describe, expect, it } from "vitest"

import { POST } from "@/app/api/chat/route"
import { NOT_CONFIGURED_MESSAGE } from "@/lib/ai"
import { executeRun } from "@/lib/agent/execute-run"
import { startRun } from "@/lib/agent/start-run"
import { textOfParts } from "@/lib/chat-types"
import { db } from "@/lib/db"
import { runs } from "@/lib/db/schema"
import { insertChat } from "@/lib/chat-store"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { monthKey } from "@/lib/plans"

import { apiError, fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { cleanupUser, createTestBot, setUsage, testUserId } from "./helpers/db"
import { newChat, readChat, send } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const FAST = { retryBaseMs: 20, progressIntervalMs: 50 }

const users: string[] = []
// A user of its own for each test: sends are rate limited per user.
async function freshUser() {
  const userId = testUserId()
  users.push(userId)
  return { userId, bot: await createTestBot(userId) }
}

// Sends a message and lets its reply fail.
async function failedReply(userId: string, chatId: string, text = "Hello there") {
  const sent = await send(userId, chatId, text)
  const result = await executeRun(sent.run.runId, {
    ...FAST,
    model: fakeModel([{ error: apiError(400, "Bad request") }]),
  })
  expect(result).toEqual({ status: "error" })
  return sent
}

function retry(userId: string, chatId: string, retryOf: string) {
  return startRun({ userId, chatId, retryOf, plan: "pro" })
}

function post(body: unknown) {
  return POST(
    new Request("http://test.local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

afterEach(() => {
  resetProviderOverrides()
  signOut()
})

afterAll(async () => {
  await Promise.all(users.map(cleanupUser))
})

describe("retrying a failed reply", () => {
  it("answers the same message again and replaces the failed reply", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const first = await failedReply(userId, chatId, "What is 2 + 2?")

    let state = await readChat(chatId)
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].status).toBe("error")

    const again = await retry(userId, chatId, first.userMessageId)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    // The same message, a new run and a new reply.
    expect(again.userMessageId).toBe(first.userMessageId)
    expect(again.run.runId).not.toBe(first.run.runId)
    expect(again.run.assistantMessageId).not.toBe(first.run.assistantMessageId)

    const model = fakeModel([{ text: ["Four."] }])
    expect(await executeRun(again.run.runId, { ...FAST, model })).toEqual({
      status: "done",
    })

    state = await readChat(chatId)
    // One question, one answer: the failed reply is gone and nothing was
    // saved twice.
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1)
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0]).toMatchObject({ status: "done" })
    expect(textOfParts(state.replies[0].parts)).toBe("Four.")
    expect(state.runs).toHaveLength(2)

    // The model saw the question once, not twice.
    const prompt = JSON.stringify(model.doStreamCalls[0].prompt)
    expect(prompt.split("What is 2 + 2?")).toHaveLength(2)
  })

  it("can be tried again and again, and each failed reply is replaced", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const first = await failedReply(userId, chatId)

    const second = await retry(userId, chatId, first.userMessageId)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    await executeRun(second.run.runId, {
      ...FAST,
      model: fakeModel([{ error: apiError(400) }]),
    })
    expect((await readChat(chatId)).replies).toHaveLength(1)

    const third = await retry(userId, chatId, first.userMessageId)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    await executeRun(third.run.runId, { ...FAST, model: fakeModel([{ text: ["Ok."] }]) })

    const state = await readChat(chatId)
    expect(state.replies).toHaveLength(1)
    expect(state.replies[0].status).toBe("done")
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1)
  })

  it("works after the queue was down, which also leaves a failed reply", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ failEnqueue: true }) })
    const chatId = await newChat(userId, bot.id)
    const sent = await send(userId, chatId, "Are you there?")
    expect((await readChat(chatId)).replies[0].status).toBe("error")

    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const again = await retry(userId, chatId, sent.userMessageId)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(
      await executeRun(again.run.runId, { ...FAST, model: fakeModel([{ text: ["Yes."] }]) })
    ).toEqual({ status: "done" })
  })

  it("is answered by the same bot in a group chat, whoever is mentioned", async () => {
    const { userId, bot: first } = await freshUser()
    const second = await createTestBot(userId, { name: "Second" })
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await insertChat(userId, {
      botIds: [first.id, second.id],
      title: "Both",
      group: true,
    })
    if (!chatId) throw new Error("no group chat")

    // The second bot is asked, and fails.
    const sent = await send(userId, chatId, "@Second what do you think?")
    await executeRun(sent.run.runId, {
      ...FAST,
      model: fakeModel([{ error: apiError(400) }]),
    })

    const again = await retry(userId, chatId, sent.userMessageId)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.run.botId).toBe(second.id)
  })
})

describe("what can't be retried", () => {
  it("a reply that worked", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const sent = await send(userId, chatId, "Hello")
    await executeRun(sent.run.runId, { ...FAST, model: fakeModel([{ text: ["Hi"] }]) })

    const result = await retry(userId, chatId, sent.userMessageId)
    expect(result).toMatchObject({ ok: false, status: 404, code: "not_retryable" })
    expect((await readChat(chatId)).runs).toHaveLength(1)
  })

  it("a reply that is still being written", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const sent = await send(userId, chatId, "Hello")

    // Not "can't be retried": it is being answered.
    expect(await retry(userId, chatId, sent.userMessageId)).toMatchObject({
      ok: false,
      status: 409,
      code: "chat_busy",
    })
  })

  it("an older message, once a newer one has been sent", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const old = await failedReply(userId, chatId, "First question")
    await send(userId, chatId, "Second question")

    expect(await retry(userId, chatId, old.userMessageId)).toMatchObject({
      ok: false,
      code: "not_retryable",
    })
  })

  it("a message ID that doesn't exist, or is empty", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    await failedReply(userId, chatId)

    expect(await retry(userId, chatId, "nope")).toMatchObject({
      ok: false,
      code: "not_retryable",
    })
    expect(await retry(userId, chatId, "")).toMatchObject({ ok: false })
  })

  it("someone else's chat, or a message from a chat of your own that isn't this one", async () => {
    const { userId, bot } = await freshUser()
    const other = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    // Another user, naming the owner's chat and message.
    const stranger = await retry(other.userId, chatId, failed.userMessageId)
    expect(stranger).toMatchObject({ ok: false, status: 404, code: "not_found" })

    // The owner, naming the failed message but another chat of their own.
    const elsewhere = await newChat(userId, bot.id)
    expect(await retry(userId, elsewhere, failed.userMessageId)).toMatchObject({
      ok: false,
      code: "not_retryable",
    })

    // Nothing changed in the owner's chat: still one failed reply.
    const state = await readChat(chatId)
    expect(state.runs).toHaveLength(1)
    expect(state.replies[0].status).toBe("error")
  })
})

describe("retrying more than once at the same moment", () => {
  it("starts exactly one reply and loses nothing", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    const results = await Promise.all(
      Array.from({ length: 4 }, () => retry(userId, chatId, failed.userMessageId))
    )

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    for (const refused of results.filter((r) => !r.ok)) {
      expect(refused).toMatchObject({ ok: false, status: 409, code: "chat_busy" })
    }

    const state = await readChat(chatId)
    // The failed run and the one new one; the failed reply was replaced once.
    expect(state.runs).toHaveLength(2)
    expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1)
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1)
  })
})

describe("limits still apply to a retry", () => {
  it("takes a reply from the month's allowance, and is refused when none is left", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    // Pro allows 1000 replies a month: leave exactly none.
    await setUsage(userId, monthKey(), { runs: 1000 })
    const refused = await retry(userId, chatId, failed.userMessageId)
    expect(refused).toMatchObject({ ok: false, status: 402 })

    // Refused means nothing changed: the failed reply is still there to retry.
    const state = await readChat(chatId)
    expect(state.runs).toHaveLength(1)
    expect(state.replies[0].status).toBe("error")

    await setUsage(userId, monthKey(), { runs: 5 })
    expect((await retry(userId, chatId, failed.userMessageId)).ok).toBe(true)
  })

  it("is refused for a bot the plan no longer covers", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    // On Free only the 3 oldest bots can be used; make 3 more that are older.
    // (Created with earlier dates so this one is the 4th.)
    for (let i = 0; i < 3; i++) {
      await createTestBot(userId, {
        name: `Older ${i}`,
        createdAt: new Date(Date.now() - 86_400_000 * (i + 1)),
      })
    }
    const result = await startRun({
      userId,
      chatId,
      retryOf: failed.userMessageId,
      plan: "free",
    })
    expect(result).toMatchObject({ ok: false, code: "bot_read_only" })
  })
})

describe("POST /api/chat with retryOf", () => {
  it("retries, ignoring any text sent with it", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId, "The real question")

    signInAs(userId)
    const response = await post({
      id: chatId,
      retryOf: failed.userMessageId,
      text: "A different message that must not be saved",
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { run: { runId: string }; userMessageId: string }
    expect(body.userMessageId).toBe(failed.userMessageId)

    const state = await readChat(chatId)
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1)
    expect(JSON.stringify(state.messages)).not.toContain("must not be saved")

    const [row] = await db.select().from(runs).where(eq(runs.id, body.run.runId))
    expect(row.userMessageId).toBe(failed.userMessageId)
  })

  it("needs a session, and refuses bad bodies", async () => {
    const { userId, bot } = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    expect((await post({ id: chatId, retryOf: failed.userMessageId })).status).toBe(401)

    signInAs(userId)
    for (const body of [
      { id: chatId, retryOf: 5 },
      { id: chatId, retryOf: "" },
      { id: chatId, retryOf: "x".repeat(65) },
      { id: chatId, retryOf: { $ne: null } },
      { id: chatId },
      { retryOf: failed.userMessageId },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await readChat(chatId)).runs).toHaveLength(1)
  })

  it("won't use someone else's message", async () => {
    const { userId, bot } = await freshUser()
    const other = await freshUser()
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, bot.id)
    const failed = await failedReply(userId, chatId)

    signInAs(other.userId)
    const response = await post({ id: chatId, retryOf: failed.userMessageId })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { code: string }).code).toBe("not_found")
  })
})

describe("when replies aren't switched on", () => {
  it("says so without naming a setting, and saves nothing", async () => {
    const { userId, bot } = await freshUser()
    signInAs(userId)
    const chatId = await newChat(userId, bot.id)

    const response = await post({ id: chatId, text: "Hello" })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe(NOT_CONFIGURED_MESSAGE)
    expect(body.error).not.toMatch(/[A-Z]{3,}_[A-Z_]+/)
    expect((await readChat(chatId)).messages).toHaveLength(0)
  })
})
