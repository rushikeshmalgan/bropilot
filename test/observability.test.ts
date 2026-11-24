import { tool } from "ai"
import { z } from "zod"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { executeRun } from "@/lib/agent/execute-run"
import { instrumentTools } from "@/lib/agent/tools/instrument"
import {
  captureError,
  flushTelemetry,
  initWorkerTelemetry,
  tagTelemetry,
  telemetryEnabled,
  withSpan,
  withTelemetryScope,
} from "@/lib/observability"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { getOrCreateSandbox } from "@/lib/sandbox"
import { scrubEvent } from "@/lib/sentry-scrub"

import { apiError, fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { fakeSandbox } from "./fakes/fake-sandbox"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, send } from "./helpers/runs"

// A recording stand-in for the Sentry SDK. It keeps what the app asked it to
// do, so tests can check what would have been sent without sending anything.
const sentry = vi.hoisted(() => {
  type Scope = {
    tags: Record<string, string>
    setTags: (tags: Record<string, string>) => void
  }
  type Span = {
    name: string
    op: string
    attributes: Record<string, unknown>
    status?: { code: number; message?: string }
    isolationTags: Record<string, string>
  }

  const makeScope = (): Scope => {
    const scope: Scope = {
      tags: {},
      setTags: (tags) => {
        Object.assign(scope.tags, tags)
      },
    }
    return scope
  }

  const state = {
    spans: [] as Span[],
    captured: [] as {
      error: unknown
      tags: Record<string, string>
      isolationTags: Record<string, string>
    }[],
    scopes: [] as Scope[],
    flushed: [] as number[],
    inits: [] as Record<string, unknown>[],
    hasClient: false,
    failFlush: false,
    failCapture: false,
  }

  const defaultScope = makeScope()
  const stack: Scope[] = []
  let local: Scope | null = null
  const current = () => stack[stack.length - 1] ?? defaultScope

  const fakeSdk = {
    init: (options: Record<string, unknown>) => {
      state.inits.push(options)
      state.hasClient = true
    },
    getClient: () => (state.hasClient ? {} : undefined),
    startSpan: (
      options: { name: string; op: string; attributes?: Record<string, unknown> },
      callback: (span: { setStatus: (status: Span["status"]) => void }) => unknown
    ) => {
      const span: Span = {
        name: options.name,
        op: options.op,
        attributes: options.attributes ?? {},
        isolationTags: { ...current().tags },
      }
      state.spans.push(span)
      return callback({
        setStatus: (status) => {
          span.status = status
        },
      })
    },
    withIsolationScope: (callback: (scope: Scope) => unknown) => {
      const scope = makeScope()
      state.scopes.push(scope)
      stack.push(scope)
      const result = callback(scope)
      void Promise.resolve(result).then(
        () => stack.splice(stack.indexOf(scope), 1),
        () => stack.splice(stack.indexOf(scope), 1)
      )
      return result
    },
    getIsolationScope: () => current(),
    withScope: (callback: (scope: Scope) => void) => {
      const previous = local
      local = makeScope()
      try {
        callback(local)
      } finally {
        local = previous
      }
    },
    captureException: (error: unknown) => {
      if (state.failCapture) {
        throw new Error("sentry is broken")
      }
      state.captured.push({
        error,
        tags: { ...(local?.tags ?? {}) },
        isolationTags: { ...current().tags },
      })
    },
    flush: async (timeout: number) => {
      state.flushed.push(timeout)
      if (state.failFlush) {
        throw new Error("sentry is broken")
      }
      return true
    },
  }

  const reset = () => {
    state.spans.length = 0
    state.captured.length = 0
    state.scopes.length = 0
    state.flushed.length = 0
    state.inits.length = 0
    state.hasClient = false
    state.failFlush = false
    state.failCapture = false
    stack.length = 0
    local = null
    defaultScope.tags = {}
  }

  return { state, fakeSdk, reset }
})

vi.mock("@sentry/node", () => sentry.fakeSdk)

const DSN = "https://publickey@o0.ingest.example/1"

function enable() {
  process.env.SENTRY_DSN = DSN
}

beforeEach(() => {
  sentry.reset()
})

afterEach(() => {
  delete process.env.SENTRY_DSN
  resetProviderOverrides()
})

describe("with no SENTRY_DSN", () => {
  it("does nothing at all, and the app's own code still runs", async () => {
    expect(telemetryEnabled()).toBe(false)

    const value = await withSpan({ name: "x", op: "y" }, async (span) => {
      span.fail("ignored")
      return 42
    })
    expect(value).toBe(42)
    expect(await withTelemetryScope(async () => "inside")).toBe("inside")
    await tagTelemetry({ userId: "user_1" })
    await captureError(new Error("nope"), { userId: "user_1" })
    await initWorkerTelemetry()
    await flushTelemetry()

    expect(sentry.state.spans).toHaveLength(0)
    expect(sentry.state.scopes).toHaveLength(0)
    expect(sentry.state.captured).toHaveLength(0)
    expect(sentry.state.inits).toHaveLength(0)
    expect(sentry.state.flushed).toHaveLength(0)
  })

  it("still lets an error from the wrapped code through", async () => {
    await expect(
      withSpan({ name: "x", op: "y" }, async () => {
        throw new Error("real failure")
      })
    ).rejects.toThrow("real failure")
  })

  it("uses the tools exactly as they were built", () => {
    const tools = { a: tool({ description: "a", inputSchema: z.object({}), execute: async () => 1 }) }
    expect(instrumentTools(tools)).toBe(tools)
  })

  it("runs a reply with no spans, tags or reports", async () => {
    const userId = testUserId()
    try {
      const bot = await createTestBot(userId)
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const chatId = await newChat(userId, bot.id)
      const { run } = await send(userId, chatId, "Hello")

      const result = await executeRun(run.runId, {
        model: fakeModel([{ text: ["Hi"] }]),
        retryBaseMs: 20,
        progressIntervalMs: 50,
      })
      expect(result).toEqual({ status: "done" })
      expect(sentry.state.spans).toHaveLength(0)
      expect(sentry.state.captured).toHaveLength(0)
    } finally {
      await cleanupUser(userId)
    }
  })
})

describe("with SENTRY_DSN set", () => {
  beforeEach(enable)

  it("puts the work inside a named span and returns what it returned", async () => {
    const value = await withSpan(
      { name: "model call", op: "model", attributes: { attempt: 2 } },
      async () => "result"
    )
    expect(value).toBe("result")
    expect(sentry.state.spans).toEqual([
      expect.objectContaining({
        name: "model call",
        op: "model",
        attributes: { attempt: 2 },
      }),
    ])
  })

  it("marks a span failed on request, and lets a thrown error through", async () => {
    await withSpan({ name: "a", op: "x" }, async (span) => span.fail("because"))
    expect(sentry.state.spans[0].status).toEqual({ code: 2, message: "because" })

    await expect(
      withSpan({ name: "b", op: "x" }, async () => {
        throw new Error("kaboom")
      })
    ).rejects.toThrow("kaboom")
  })

  it("only sends short plain attributes", async () => {
    await withSpan(
      {
        name: "a",
        op: "x",
        attributes: {
          "bot.id": "bot_abc123",
          sentence: "has a\nnewline",
          long: "x".repeat(100),
          count: 3,
        },
      },
      async () => null
    )
    expect(sentry.state.spans[0].attributes).toEqual({ "bot.id": "bot_abc123", count: 3 })
  })

  it("tags errors with the IDs it is given, and drops anything else", async () => {
    await captureError(new Error("bad"), {
      userId: "user_2abc",
      botId: "bot 1; drop",
      runId: "run_1",
      // @ts-expect-error: not one of the four tags
      secret: "sk-should-not-be-here",
    })
    expect(sentry.state.captured).toHaveLength(1)
    expect(sentry.state.captured[0].tags).toEqual({ userId: "user_2abc", runId: "run_1" })
  })

  it("never lets a broken Sentry break the app", async () => {
    sentry.state.failCapture = true
    sentry.state.failFlush = true
    await expect(captureError(new Error("x"))).resolves.toBeUndefined()
    await expect(flushTelemetry()).resolves.toBeUndefined()
  })

  it("keeps each scope's tags to itself", async () => {
    await withTelemetryScope(async () => {
      await tagTelemetry({ runId: "run_a", userId: "user_a" })
    })
    await withTelemetryScope(async () => {
      await tagTelemetry({ runId: "run_b" })
    })
    expect(sentry.state.scopes.map((scope) => scope.tags)).toEqual([
      { runId: "run_a", userId: "user_a" },
      { runId: "run_b" },
    ])
  })

  it("waits for events to be sent, for as long as it is told", async () => {
    await flushTelemetry()
    await flushTelemetry(500)
    expect(sentry.state.flushed).toEqual([2000, 500])
  })

  it("starts Sentry in the worker with the app's options, once", async () => {
    await initWorkerTelemetry()
    await initWorkerTelemetry()
    expect(sentry.state.inits).toHaveLength(1)
    expect(sentry.state.inits[0]).toMatchObject({
      dsn: DSN,
      dataCollection: { userInfo: false, httpBodies: [], genAI: { inputs: false } },
      beforeSend: scrubEvent,
    })
  })

  it("does not start Sentry again where Next.js already did", async () => {
    sentry.state.hasClient = true
    await initWorkerTelemetry()
    expect(sentry.state.inits).toHaveLength(0)
  })
})

describe("tool spans", () => {
  beforeEach(enable)

  const echo = tool({
    description: "echo",
    inputSchema: z.object({ q: z.string() }),
    execute: async ({ q }: { q: string }) => ({ echoed: q }),
  })
  const failing = tool({
    description: "failing",
    inputSchema: z.object({}),
    execute: async () => ({ error: "That didn't work." }),
  })
  const throwing = tool({
    description: "throwing",
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      throw new Error("tool crashed")
    },
  })
  const clientSide = tool({ description: "client", inputSchema: z.object({}) })

  async function call(wrapped: ReturnType<typeof instrumentTools>, name: string, input: unknown) {
    const execute = wrapped[name].execute as (input: unknown, options: unknown) => Promise<unknown>
    return execute(input, { toolCallId: "t1", messages: [] })
  }

  it("gives each call its own span named after the tool, and changes nothing else", async () => {
    const wrapped = instrumentTools({ echo, failing, throwing, clientSide })

    expect(await call(wrapped, "echo", { q: "MY PRIVATE QUESTION" })).toEqual({
      echoed: "MY PRIVATE QUESTION",
    })
    expect(sentry.state.spans).toHaveLength(1)
    expect(sentry.state.spans[0]).toMatchObject({
      name: "tool echo",
      op: "tool",
      attributes: { "tool.name": "echo" },
    })
    expect(sentry.state.spans[0].status).toBeUndefined()
    // What the model asked for and what came back never go into a span.
    expect(JSON.stringify(sentry.state.spans)).not.toContain("MY PRIVATE QUESTION")
    expect(wrapped.echo.description).toBe("echo")
    expect(wrapped.clientSide).toBe(clientSide)
  })

  it("marks a tool that returned an error, and passes a crash on", async () => {
    const wrapped = instrumentTools({ failing, throwing })

    expect(await call(wrapped, "failing", {})).toEqual({ error: "That didn't work." })
    expect(sentry.state.spans[0].status?.code).toBe(2)

    await expect(call(wrapped, "throwing", {})).rejects.toThrow("tool crashed")
  })
})

describe("a reply", () => {
  const userId = testUserId()
  let botId = ""

  beforeAll(async () => {
    botId = (await createTestBot(userId)).id
  })
  afterAll(() => cleanupUser(userId))

  async function start(text = "Hello") {
    overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
    const chatId = await newChat(userId, botId)
    const { run } = await send(userId, chatId, text)
    return { chatId, runId: run.runId }
  }

  const FAST = { retryBaseMs: 20, progressIntervalMs: 50 }

  beforeEach(enable)

  it("is traced with its four IDs, a span for the model call and one for each tool", async () => {
    const { chatId, runId } = await start()

    const result = await executeRun(runId, {
      ...FAST,
      model: fakeModel([
        { toolCalls: [{ name: "memoryList", input: {} }] },
        { text: ["Done."] },
      ]),
    })
    expect(result).toEqual({ status: "done" })

    const names = sentry.state.spans.map((span) => span.name)
    expect(names).toContain("run")
    expect(names).toContain("model call")
    expect(names).toContain("tool memoryList")
    expect(sentry.state.spans.find((span) => span.name === "run")?.attributes).toEqual({
      "run.id": runId,
    })

    // The run's own scope carries all four IDs; no other scope was used.
    expect(sentry.state.scopes).toHaveLength(1)
    expect(sentry.state.scopes[0].tags).toEqual({ runId, botId, chatId, userId })
    expect(sentry.state.captured).toHaveLength(0)
  })

  it("reports a reply that failed for good, with its IDs, and a retried 429 that worked is not reported", async () => {
    const failed = await start()
    expect(
      await executeRun(failed.runId, {
        ...FAST,
        model: fakeModel([{ error: apiError(400, "Bad request") }]),
      })
    ).toEqual({ status: "error" })

    expect(sentry.state.captured).toHaveLength(1)
    expect(sentry.state.captured[0].isolationTags).toMatchObject({ runId: failed.runId, botId })
    const modelSpan = sentry.state.spans.find((span) => span.name === "model call")
    expect(modelSpan?.status?.message).toBe("error")
    expect(sentry.state.spans.find((span) => span.name === "run")?.status?.message).toBe(
      "run failed"
    )

    sentry.reset()
    enable()
    const recovered = await start()
    expect(
      await executeRun(recovered.runId, {
        ...FAST,
        model: fakeModel([{ error: apiError(429) }, { text: ["Fine."] }]),
      })
    ).toEqual({ status: "done" })
    expect(sentry.state.captured).toHaveLength(0)
    // Two model calls: the one that was refused and the one that worked.
    expect(sentry.state.spans.filter((span) => span.name === "model call")).toHaveLength(2)
  })

  it("reports an empty reply without putting anything the model said in the report", async () => {
    const { runId } = await start()
    await executeRun(runId, { ...FAST, model: fakeModel([{ text: [] }]) })
    expect(sentry.state.captured).toHaveLength(1)
    expect((sentry.state.captured[0].error as Error).message).toBe(
      "The model returned an empty reply"
    )
  })

  it("reports a queue that is down, with the IDs of the reply that couldn't start", async () => {
    overrideProviders({ runQueue: fakeRunQueue({ failEnqueue: true }) })
    const chatId = await newChat(userId, botId)
    await send(userId, chatId, "Hello")

    expect(sentry.state.captured).toHaveLength(1)
    expect(sentry.state.captured[0].tags).toMatchObject({ userId, chatId, botId })
    expect(sentry.state.captured[0].tags.runId).toBeTruthy()
  })
})

describe("creating a sandbox", () => {
  const userId = testUserId()
  let botId = ""

  beforeAll(async () => {
    botId = (await createTestBot(userId)).id
  })
  afterAll(() => cleanupUser(userId))
  beforeEach(enable)

  it("is a span of its own", async () => {
    const result = await getOrCreateSandbox(userId, botId, {
      provider: fakeSandbox(),
      plan: "pro",
    })
    expect(result.ok).toBe(true)
    expect(sentry.state.spans).toEqual([
      expect.objectContaining({
        name: "sandbox create",
        op: "sandbox",
        attributes: { "bot.id": botId },
      }),
    ])
    expect(sentry.state.spans[0].status).toBeUndefined()
    expect(sentry.state.captured).toHaveLength(0)
  })

  it("is marked failed when it fails, and reported only when the failure was a surprise", async () => {
    const expected = fakeSandbox({ failCreates: 1 })
    const first = await getOrCreateSandbox(userId, botId, { provider: expected, plan: "pro" })
    expect(first.ok).toBe(false)
    expect(sentry.state.spans[0].status?.message).toBe("failed")
    // The provider said what was wrong in words meant for people: not reported.
    expect(sentry.state.captured).toHaveLength(0)

    sentry.reset()
    enable()
    const surprising = fakeSandbox()
    const broken = {
      ...surprising,
      create: async () => {
        throw new TypeError("fetch failed")
      },
    }
    const second = await getOrCreateSandbox(userId, botId, {
      provider: broken as typeof surprising,
      plan: "pro",
    })
    expect(second.ok).toBe(false)
    expect(sentry.state.spans[0].status?.message).toBe("failed")
    expect(sentry.state.captured).toHaveLength(1)
    expect(sentry.state.captured[0].tags).toEqual({ userId, botId })
    expect(sentry.state.captured[0].error).toBeInstanceOf(TypeError)
  })
})

describe("the Trigger.dev task", () => {
  beforeEach(enable)

  async function loadTask(flushImpl: () => Promise<void> = async () => {}) {
    vi.resetModules()
    vi.doMock("@trigger.dev/sdk", () => ({
      task: (definition: unknown) => definition,
      metadata: { set: () => {}, flush: flushImpl },
    }))
    const loaded = await import("@/src/trigger/execute-run")
    return loaded.executeRunTask as unknown as {
      run: (payload: { runId: string }) => Promise<unknown>
    }
  }

  it("starts Sentry for the worker and sends what is queued before it exits", async () => {
    const task = await loadTask()
    const result = await task.run({ runId: "no_such_run" })
    expect(result).toEqual({ status: "missing" })
    expect(sentry.state.inits).toHaveLength(1)
    expect(sentry.state.flushed).toHaveLength(1)
  })

  it("still sends what is queued when the task fails", async () => {
    const task = await loadTask(async () => {
      throw new Error("metadata is down")
    })
    await expect(task.run({ runId: "no_such_run" })).rejects.toThrow("metadata is down")
    expect(sentry.state.flushed).toHaveLength(1)
  })
})
