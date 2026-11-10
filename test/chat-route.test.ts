import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { POST } from "@/app/api/chat/route"
import { GET as getRun } from "@/app/api/runs/[id]/route"
import {
  CHAT_BUSY_MESSAGE,
  ENQUEUE_FAILED_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  RATE_LIMIT_MAX_MESSAGES,
} from "@/lib/ai"
import { attachRun, stopRun } from "@/lib/actions"
import { applyRunSnapshot } from "@/lib/chat-messages"
import { MAX_MESSAGE_LENGTH } from "@/lib/chat-limits"
import {
  textOfParts,
  type ChatMessage,
  type RunHandle,
  type RunSnapshot,
} from "@/lib/chat-types"
import type { Bot } from "@/lib/db/schema"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { followRun, readLiveProgress } from "@/lib/run-progress"

import { fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, readChat } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const FAST = { retryBaseMs: 40, progressIntervalMs: 60 }

function post(body: unknown) {
  return POST(
    new Request("http://test.local/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
}

// Reads a run through the same route the browser polls.
async function fetchRun(runId: string) {
  const response = await getRun(new Request(`http://test.local/api/runs/${runId}`), {
    params: Promise.resolve({ id: runId }),
  })
  return {
    status: response.status,
    body: (await response.json()) as RunSnapshot & { code?: string },
  }
}

describe("POST /api/chat and run following", () => {
  const owner = testUserId()
  const second = testUserId()
  const stranger = testUserId()
  let bot: Bot
  let secondBot: Bot

  beforeAll(async () => {
    bot = await createTestBot(owner)
    secondBot = await createTestBot(second)
  })

  afterEach(() => {
    resetProviderOverrides()
    signOut()
  })

  afterAll(async () => {
    await Promise.all([owner, second, stranger].map(cleanupUser))
  })

  it("refuses a request without a session", async () => {
    const chatId = await newChat(owner, bot.id)
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })

    const response = await post({ id: chatId, text: "Hello" })

    expect(response.status).toBe(401)
    expect((await readChat(chatId)).messages).toHaveLength(0)
  })

  it("refuses malformed, empty and oversized input", async () => {
    signInAs(owner)
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })
    const chatId = await newChat(owner, bot.id)

    expect((await post("{not json")).status).toBe(400)
    expect((await post({ text: "no chat" })).status).toBe(400)
    expect((await post({ id: chatId, text: 42 })).status).toBe(400)
    expect((await post({ id: "x".repeat(65), text: "Hi" })).status).toBe(400)
    expect((await post({ id: chatId, text: "   " })).status).toBe(400)

    const tooLong = await post({
      id: chatId,
      text: "a".repeat(MAX_MESSAGE_LENGTH + 1),
    })
    expect(tooLong.status).toBe(400)
    expect((await tooLong.json()).code).toBe("message_too_long")

    expect(queue.enqueued).toHaveLength(0)
    expect((await readChat(chatId)).messages).toHaveLength(0)
  })

  it("treats someone else's chat as not existing and saves nothing", async () => {
    const chatId = await newChat(owner, bot.id)
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })

    signInAs(stranger)
    const response = await post({ id: chatId, text: "Let me in" })

    expect(response.status).toBe(404)
    expect(queue.enqueued).toHaveLength(0)
    const state = await readChat(chatId)
    expect(state.messages).toHaveLength(0)
    expect(state.runs).toHaveLength(0)
  })

  it("says so when the queue isn't configured, and saves nothing", async () => {
    // No override and no TRIGGER_SECRET_KEY in tests: nothing is configured.
    signInAs(owner)
    const chatId = await newChat(owner, bot.id)

    const response = await post({ id: chatId, text: "Hello" })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: "not_configured",
      error: NOT_CONFIGURED_MESSAGE,
    })
    expect((await readChat(chatId)).messages).toHaveLength(0)
  })

  it("returns a run instead of a reply, and the reply arrives by polling", async () => {
    signInAs(owner)
    const chatId = await newChat(owner, bot.id)
    const words = Array.from({ length: 30 }, (_, i) => `word${i} `)
    const model = fakeModel([{ text: words, chunkDelayMs: 100 }])
    const queue = fakeRunQueue({ deps: { ...FAST, model } })
    overrideProviders({ runQueue: queue })

    const response = await post({ id: chatId, text: "Tell me a story" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const { run, userMessageId } = (await response.json()) as {
      run: RunHandle
      userMessageId: string
    }
    // The fake queue has no live updates, so the browser polls.
    expect(run.live).toBeNull()

    // Follow the run exactly as the chat screen does: the polling loop reads
    // the ownership-checked route, and each state is applied to the list.
    let screen: ChatMessage[] = [
      {
        id: userMessageId,
        role: "user",
        botId: null,
        parts: [{ type: "text", text: "Tell me a story" }],
        status: "done",
      },
    ]
    const seen: RunSnapshot[] = []
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("never finished")), 40_000)
      followRun({
        runId: run.runId,
        intervalMs: () => 150,
        fetchSnapshot: async (runId) => {
          const { status, body } = await fetchRun(runId)
          return status === 200 ? body : null
        },
        onSnapshot: (snapshot) => {
          seen.push(snapshot)
          screen = applyRunSnapshot(screen, snapshot)
          if (snapshot.status === "done") {
            clearTimeout(timeout)
            resolve()
          }
        },
        onGone: () => reject(new Error("run disappeared")),
      })
    })

    // Progress was visible before the end, and only ever grew.
    const lengths = seen.map((snapshot) =>
      snapshot.message ? textOfParts(snapshot.message.parts).length : 0
    )
    expect(seen.some((s) => s.status === "running" && s.message)).toBe(true)
    expect(lengths.some((n) => n > 0 && n < words.join("").length)).toBe(true)
    expect([...lengths].sort((a, b) => a - b)).toEqual(lengths)

    // The final screen text equals the database row.
    await queue.settle()
    const state = await readChat(chatId)
    const reply = screen.find((m) => m.id === run.assistantMessageId)!
    expect(reply.status).toBe("done")
    expect(reply.parts).toEqual(state.replies[0].parts)
    expect(textOfParts(reply.parts)).toBe(words.join(""))
    expect(screen.map((m) => m.id)).toEqual(state.messages.map((m) => m.id))
  })

  it("hides a run from anyone but the chat's owner", async () => {
    signInAs(owner)
    const chatId = await newChat(owner, bot.id)
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })
    const { run } = (await (await post({ id: chatId, text: "Secret" })).json()) as {
      run: RunHandle
    }

    signInAs(stranger)
    expect((await fetchRun(run.runId)).status).toBe(404)
    expect(await attachRun(run.runId)).toBeNull()
    expect(await stopRun(run.runId)).toEqual({
      error: "That reply doesn't exist.",
    })

    signOut()
    expect((await fetchRun(run.runId)).status).toBe(401)
    expect(await attachRun(run.runId)).toBeNull()
    expect(await stopRun(run.runId)).toEqual({
      error: "You need to be signed in.",
    })

    // The stranger's Stop did nothing.
    signInAs(owner)
    expect((await fetchRun(run.runId)).body.status).toBe("queued")
    expect(queue.cancelled).toHaveLength(0)
  })

  it("accepts one of two sends made at the same moment", async () => {
    signInAs(owner)
    const chatId = await newChat(owner, bot.id)
    const queue = fakeRunQueue({ autoRun: false })
    overrideProviders({ runQueue: queue })

    const responses = await Promise.all([
      post({ id: chatId, text: "First" }),
      post({ id: chatId, text: "Second" }),
    ])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    const refused = responses.find((r) => r.status === 409)!
    expect(await refused.json()).toEqual({
      code: "chat_busy",
      error: CHAT_BUSY_MESSAGE,
    })
    // The refused message was not saved, so nothing is left unanswered.
    const state = await readChat(chatId)
    expect(state.messages).toHaveLength(1)
    expect(state.runs).toHaveLength(1)
    expect(queue.enqueued).toHaveLength(1)
  })

  it("refuses a second message while a reply is being written", async () => {
    signInAs(owner)
    const chatId = await newChat(owner, bot.id)
    const queue = fakeRunQueue({
      autoRun: false,
      deps: { ...FAST, model: fakeModel([{ text: ["Done"] }]) },
    })
    overrideProviders({ runQueue: queue })

    expect((await post({ id: chatId, text: "One" })).status).toBe(200)
    // Another tab sends before the first reply has finished.
    expect((await post({ id: chatId, text: "Two" })).status).toBe(409)

    await queue.runNext()
    expect((await post({ id: chatId, text: "Two" })).status).toBe(200)
  })

  it("reattaches to an unfinished run after a reload", async () => {
    signInAs(second)
    const chatId = await newChat(second, secondBot.id)
    const model = fakeModel([
      { text: Array.from({ length: 20 }, () => "tick "), chunkDelayMs: 100 },
    ])
    const queue = fakeRunQueue({ deps: { ...FAST, model } })
    overrideProviders({ runQueue: queue })
    const { run } = (await (await post({ id: chatId, text: "Go" })).json()) as {
      run: RunHandle
    }

    // The page reloads: all the browser has is the run's ID from the server.
    const attached = await attachRun(run.runId)
    expect(attached?.run).toMatchObject({
      runId: run.runId,
      assistantMessageId: run.assistantMessageId,
      live: null,
    })
    expect(["queued", "running"]).toContain(attached?.snapshot.status)

    // Stop from the reloaded page; the text that arrived stays.
    const stopped = await stopRun(run.runId)
    expect("run" in stopped && stopped.run.status).toBe("cancelled")
    await queue.settle()

    // Attaching to a finished run gives its final state and nothing to follow.
    const after = await attachRun(run.runId)
    expect(after?.run).toBeNull()
    expect(after?.snapshot.status).toBe("cancelled")
    const state = await readChat(chatId)
    expect(after?.snapshot.message?.parts ?? []).toEqual(
      state.replies[0]?.parts ?? []
    )
  })

  it("keeps the message and shows an error when the queue is down", async () => {
    signInAs(second)
    const chatId = await newChat(second, secondBot.id)
    overrideProviders({ runQueue: fakeRunQueue({ failEnqueue: true }) })

    const response = await post({ id: chatId, text: "Anyone home?" })

    expect(response.status).toBe(200)
    const { run } = (await response.json()) as { run: RunHandle }
    const { body } = await fetchRun(run.runId)
    expect(body.status).toBe("error")
    expect(body.error).toBe(ENQUEUE_FAILED_MESSAGE)
    expect(body.message?.status).toBe("error")

    const state = await readChat(chatId)
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    // The chat isn't left blocked.
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    expect((await post({ id: chatId, text: "Again" })).status).toBe(200)
  })

  it("rate limits a user who sends too quickly", async () => {
    const hasty = testUserId()
    signInAs(hasty)
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })

    // The limit is checked before anything is read, so a chat that doesn't
    // exist still counts.
    for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
      expect((await post({ id: "missing-chat", text: "Hi" })).status).toBe(404)
    }

    const limited = await post({ id: "missing-chat", text: "Hi" })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0)
  })
})

describe("followRun", () => {
  const snapshot = (
    status: RunSnapshot["status"],
    text: string
  ): RunSnapshot => ({
    id: "r",
    status,
    error: null,
    assistantMessageId: "m",
    botId: "b",
    message: {
      id: "m",
      role: "assistant",
      botId: "b",
      parts: [{ type: "text", text }],
      status: status === "done" ? "done" : "streaming",
    },
  })

  it("keeps reading through failures and stops at the final state", async () => {
    const script: (RunSnapshot | Error)[] = [
      snapshot("queued", ""),
      new Error("network down"),
      snapshot("running", "Hel"),
      new Error("502"),
      snapshot("done", "Hello"),
      snapshot("done", "must never be read"),
    ]
    const seen: string[] = []

    await new Promise<void>((resolve) => {
      followRun({
        runId: "r",
        intervalMs: () => 5,
        fetchSnapshot: async () => {
          const next = script.shift()!
          if (next instanceof Error) {
            throw next
          }
          return next
        },
        onSnapshot: (state) => {
          seen.push(`${state.status}:${textOfParts(state.message!.parts)}`)
          if (state.status === "done") {
            setTimeout(resolve, 40)
          }
        },
      })
    })

    expect(seen).toEqual(["queued:", "running:Hel", "done:Hello"])
    expect(script).toHaveLength(1)
  })

  it("reports a run that no longer exists and stops", async () => {
    let reads = 0
    const gone = await new Promise<boolean>((resolve) => {
      followRun({
        runId: "r",
        intervalMs: () => 5,
        fetchSnapshot: async () => {
          reads++
          return null
        },
        onSnapshot: () => resolve(false),
        onGone: () => setTimeout(() => resolve(true), 30),
      })
    })

    expect(gone).toBe(true)
    expect(reads).toBe(1)
  })

  it("stops reading when told to", async () => {
    let reads = 0
    const follower = followRun({
      runId: "r",
      intervalMs: () => 5,
      fetchSnapshot: async () => {
        reads++
        return snapshot("running", "x")
      },
      onSnapshot: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 40))
    follower.stop()
    const at = reads
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(at).toBeGreaterThan(1)
    expect(reads).toBe(at)
  })
})

describe("live updates and the message list", () => {
  it("ignores stale and malformed live updates", () => {
    const parts = [{ type: "text", text: "Hi" }]
    expect(readLiveProgress({ seq: 3, parts }, 2)).toEqual({ seq: 3, parts })
    expect(readLiveProgress({ seq: 2, parts }, 2)).toBeNull()
    expect(readLiveProgress({ seq: 1, parts }, 2)).toBeNull()
    expect(readLiveProgress({ seq: "9", parts }, 2)).toBeNull()
    expect(readLiveProgress({ seq: 3, parts: "nope" }, 2)).toBeNull()
    expect(readLiveProgress(null, 0)).toBeNull()
    expect(readLiveProgress(undefined, 0)).toBeNull()
    // Too big to send live: the caller is told to read the database.
    expect(readLiveProgress({ seq: 4 }, 2)).toEqual({ seq: 4, parts: null })
  })

  it("shows a placeholder while a run is unfinished and the saved row after", () => {
    const user: ChatMessage = {
      id: "u",
      role: "user",
      botId: null,
      parts: [{ type: "text", text: "Hi" }],
      status: "done",
    }
    const base = { id: "r", error: null, assistantMessageId: "m", botId: "b" }

    const queued = applyRunSnapshot([user], {
      ...base,
      status: "queued",
      message: null,
    })
    expect(queued.map((m) => [m.id, m.status])).toEqual([
      ["u", "done"],
      ["m", "streaming"],
    ])
    // Applying the same state twice doesn't add a second placeholder.
    expect(
      applyRunSnapshot(queued, { ...base, status: "queued", message: null })
    ).toHaveLength(2)

    const saved: ChatMessage = {
      id: "m",
      role: "assistant",
      botId: "b",
      parts: [{ type: "text", text: "Hello" }],
      status: "done",
    }
    expect(
      applyRunSnapshot(queued, { ...base, status: "done", message: saved })
    ).toEqual([user, saved])

    // Stopped before anything was written: the placeholder goes away.
    expect(
      applyRunSnapshot(queued, { ...base, status: "cancelled", message: null })
    ).toEqual([user])
  })
})
