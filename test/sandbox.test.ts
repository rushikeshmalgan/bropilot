import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { deleteBot, resetSandbox as resetSandboxAction } from "@/lib/actions"
import { executeRun } from "@/lib/agent/execute-run"
import {
  MAX_FILE_BYTES,
  MAX_PATH_CHARS,
  sandboxTools,
} from "@/lib/agent/tools/sandbox"
import { MAX_TOOL_OUTPUT_CHARS } from "@/lib/agent/tools/shared"
import { removeBot } from "@/lib/bot-delete"
import type { ToolPart } from "@/lib/chat-types"
import { db } from "@/lib/db"
import { botMemoryFiles, bots, chats, runs, type Bot } from "@/lib/db/schema"
import { writeMemory } from "@/lib/memory"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import {
  SANDBOX_AUTO_STOP_MINUTES,
  SANDBOX_CREATE_TIMEOUT_SECONDS,
  getOrCreateSandbox,
  getSandboxStatus,
  resetSandbox,
} from "@/lib/sandbox"

import { fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { fakeSandbox } from "./fakes/fake-sandbox"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, readChat, send, wait } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const FAST = { retryBaseMs: 40, progressIntervalMs: 60 }

async function recordedSandbox(botId: string) {
  const [row] = await db
    .select({ sandboxId: bots.sandboxId })
    .from(bots)
    .where(eq(bots.id, botId))
  return row?.sandboxId ?? null
}

async function setRecordedSandbox(botId: string, value: string | null) {
  await db.update(bots).set({ sandboxId: value }).where(eq(bots.id, botId))
}

// Calls a tool the way the AI SDK does.
function call<I>(t: { execute?: unknown }, input: I) {
  return (t.execute as (input: I, options: never) => Promise<unknown>)(input, {
    toolCallId: "t",
    messages: [],
  } as never)
}

describe("sandboxes", () => {
  const owner = testUserId()
  const stranger = testUserId()
  const sender = testUserId()
  let strangerBot: Bot

  // A new bot for each test, so one test's sandbox record can't leak into the next.
  async function freshBot(userId = owner) {
    return createTestBot(userId, { name: `Bot ${Math.random().toString(36).slice(2, 7)}` })
  }

  beforeAll(async () => {
    strangerBot = await createTestBot(stranger)
  })

  afterEach(() => {
    resetProviderOverrides()
    signOut()
    delete process.env.FAKE_SECRET_FOR_TEST
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await Promise.all([owner, stranger, sender].map(cleanupUser))
  })

  describe("getOrCreateSandbox", () => {
    it("creates one sandbox on first use, records it, and reuses it", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      expect(await recordedSandbox(bot.id)).toBeNull()

      const first = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      expect(first.ok).toBe(true)
      if (!first.ok) return

      expect(fake.log.created).toEqual([
        {
          botId: bot.id,
          autoStopMinutes: SANDBOX_AUTO_STOP_MINUTES,
          timeoutSeconds: SANDBOX_CREATE_TIMEOUT_SECONDS,
        },
      ])
      expect(await recordedSandbox(bot.id)).toBe(first.sandboxId)
      // It asked the sandbox who it runs as, rather than trusting a default.
      expect(fake.log.commands.map((c) => c.command)).toEqual(["id -u"])

      const second = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      expect(second).toEqual({ ok: true, sandboxId: first.sandboxId })
      expect(fake.log.created).toHaveLength(1)
    })

    it("lets parallel callers create exactly one sandbox", async () => {
      const fake = fakeSandbox({ createDelayMs: 400 })
      const bot = await freshBot()

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake, pollMs: 50 })
        )
      )

      expect(results.every((result) => result.ok)).toBe(true)
      const ids = new Set(results.map((r) => (r.ok ? r.sandboxId : "")))
      expect(ids.size).toBe(1)
      expect(fake.log.created).toHaveLength(1)
      expect(fake.liveFor(bot.id)).toBe(1)
      expect(await recordedSandbox(bot.id)).toBe([...ids][0])
    })

    it("releases the claim when creation fails, so the next try works", async () => {
      const fake = fakeSandbox({ failCreates: 1 })
      const bot = await freshBot()

      const failed = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      expect(failed).toMatchObject({ ok: false, code: "failed" })
      expect(await recordedSandbox(bot.id)).toBeNull()

      const again = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      expect(again.ok).toBe(true)
      expect(fake.liveFor(bot.id)).toBe(1)
    })

    it("refuses a sandbox that would run as an administrator, and removes it", async () => {
      const fake = fakeSandbox({ rootUser: true })
      const bot = await freshBot()

      const result = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(result).toMatchObject({ ok: false, code: "failed" })
      expect(fake.liveFor(bot.id)).toBe(0)
      expect(fake.log.deleted).toHaveLength(1)
      expect(await recordedSandbox(bot.id)).toBeNull()
    })

    it("clears a dead creator's claim and removes what it left behind", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const tenMinutesAgo = Date.now() - 10 * 60_000
      await setRecordedSandbox(bot.id, `pending:${tenMinutesAgo}:dead0001`)
      const orphan = fake.plantOrphan(bot.id)

      const result = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(result.ok).toBe(true)
      expect(fake.log.deleted).toContain(orphan)
      expect(fake.liveFor(bot.id)).toBe(1)
      expect(fake.log.created).toHaveLength(1)
      const recorded = await recordedSandbox(bot.id)
      expect(recorded).toBe(result.ok ? result.sandboxId : null)
      expect(recorded?.startsWith("pending:")).toBe(false)
    })

    it("waits for a live claim and then gives up with a busy message", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const claim = `pending:${Date.now()}:live0001`
      await setRecordedSandbox(bot.id, claim)

      const result = await getOrCreateSandbox(owner, bot.id, {
        plan: "pro",
        provider: fake,
        waitMs: 400,
        pollMs: 50,
      })

      expect(result).toMatchObject({ ok: false, code: "busy" })
      expect(fake.log.created).toHaveLength(0)
      // Someone else's claim is left exactly as it was.
      expect(await recordedSandbox(bot.id)).toBe(claim)
    })

    it("picks up the sandbox once the other creator finishes", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      await setRecordedSandbox(bot.id, `pending:${Date.now()}:live0002`)

      const waiting = getOrCreateSandbox(owner, bot.id, {
        plan: "pro",
        provider: fake,
        waitMs: 10_000,
        pollMs: 50,
      })
      await wait(300)
      const made = await fake.create({
        botId: bot.id,
        autoStopMinutes: 1,
        timeoutSeconds: 1,
      })
      await setRecordedSandbox(bot.id, made.id)

      expect(await waiting).toEqual({ ok: true, sandboxId: made.id })
      // Only the one the "other creator" made exists.
      expect(fake.liveFor(bot.id)).toBe(1)
    })

    it("starts a sandbox that switched itself off", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const first = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!first.ok) throw new Error(`setup failed: ${JSON.stringify(first)}`)

      fake.switchOff(first.sandboxId)
      expect(await fake.status(first.sandboxId)).toBe("stopped")

      const again = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(again).toEqual({ ok: true, sandboxId: first.sandboxId })
      expect(fake.log.started).toEqual([first.sandboxId])
      expect(await fake.status(first.sandboxId)).toBe("running")
      expect(fake.log.created).toHaveLength(1)
    })

    it("makes a new sandbox if the old one was deleted at the provider", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const first = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!first.ok) throw new Error(`setup failed: ${JSON.stringify(first)}`)

      fake.vanish(first.sandboxId)
      const second = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.sandboxId).not.toBe(first.sandboxId)
      expect(await recordedSandbox(bot.id)).toBe(second.sandboxId)
      expect(fake.log.created).toHaveLength(2)
    })

    it("doesn't silently replace a sandbox that is in an error state", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const first = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!first.ok) throw new Error(`setup failed: ${JSON.stringify(first)}`)

      fake.breakIt(first.sandboxId)
      const result = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(result).toMatchObject({ ok: false, code: "failed" })
      expect(result.ok ? "" : result.error).toContain("error state")
      expect(await recordedSandbox(bot.id)).toBe(first.sandboxId)
      expect(fake.log.created).toHaveLength(1)
    })

    it("treats someone else's bot as not existing, and no provider as not configured", async () => {
      const fake = fakeSandbox()

      expect(
        await getOrCreateSandbox(owner, strangerBot.id, { plan: "pro", provider: fake })
      ).toMatchObject({ ok: false, code: "not_found" })
      expect(
        await getOrCreateSandbox(owner, "no-such-bot", { plan: "pro", provider: fake })
      ).toMatchObject({ ok: false, code: "not_found" })
      expect(fake.log.created).toHaveLength(0)
      expect(await recordedSandbox(strangerBot.id)).toBeNull()

      const bot = await freshBot()
      expect(
        await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: null })
      ).toMatchObject({ ok: false, code: "not_configured" })
    })
  })

  describe("the tools", () => {
    const context = (bot: Bot, userId = owner) => ({
      userId,
      botId: bot.id,
      runId: "r", plan: "pro" as const,
    })

    it("run a command, and a failing command is data, not an error", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { bash } = sandboxTools(context(bot), fake)

      expect(await call(bash, { command: "echo hello" })).toMatchObject({
        exitCode: 0,
        output: "hello\n",
        truncated: false,
        timedOut: false,
      })
      expect(await call(bash, { command: "fail" })).toMatchObject({
        exitCode: 3,
        output: "it failed\n",
      })
      expect(await call(bash, { command: "nonsense" })).toMatchObject({
        exitCode: 127,
      })
      // The sandbox was made once, for the first command.
      expect(fake.log.created).toHaveLength(1)
    })

    it("cap the time a command may take, and report one that was stopped", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { bash } = sandboxTools(context(bot), fake)

      await call(bash, { command: "echo a" })
      await call(bash, { command: "echo b", timeoutSeconds: 5 })
      // Past the schema's own limit: still clamped to what the reply has left.
      await call(bash, { command: "echo c", timeoutSeconds: 5000 })
      const limits = fake.log.commands
        .filter((c) => c.command.startsWith("echo"))
        .map((c) => c.options.timeoutSeconds)
      // Each command used at least a second of the reply's 90.
      expect(limits).toEqual([30, 5, 88])

      const stopped = await call(bash, { command: "sleep 100", timeoutSeconds: 10 })
      expect(stopped).toMatchObject({ timedOut: true })
      expect((stopped as { note: string }).note).toContain("10 seconds")
    })

    it("stop running commands once the reply has used its sandbox time", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { bash } = sandboxTools(context(bot), fake, { secondsPerRun: 2 })

      await call(bash, { command: "echo 1" })
      await call(bash, { command: "echo 2" })
      const refused = await call(bash, { command: "echo 3" })

      expect(refused).toEqual({
        error: expect.stringContaining("used all of its sandbox time"),
      })
      expect(fake.log.commands.filter((c) => c.command === "echo 3")).toHaveLength(0)
    })

    it("cut long output, keeping the start and the end", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { bash } = sandboxTools(context(bot), fake)

      const result = (await call(bash, { command: "big 50000" })) as {
        output: string
        truncated: boolean
      }

      expect(result.truncated).toBe(true)
      // The cap, plus the short marker that says text was cut.
      expect(result.output.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 60)
      expect(result.output.startsWith("abcdefghij")).toBe(true)
      expect(result.output).toContain("characters cut")
      const tail = "abcdefghijklmnopqrstuvwxyz".repeat(2000).slice(0, 50000).slice(-20)
      expect(result.output.endsWith(tail)).toBe(true)
    })

    it("pass nothing from the server's environment into the sandbox", async () => {
      process.env.FAKE_SECRET_FOR_TEST = "s3cret-value-that-must-not-travel"
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { bash, writeFile } = sandboxTools(context(bot), fake)

      await call(bash, { command: "echo hi" })
      await call(writeFile, { path: "a.txt", content: "data" })

      // Only these fields exist on a create request, and exec carries only a
      // time limit: there is no place for an environment variable to go.
      expect(Object.keys(fake.log.created[0]).sort()).toEqual([
        "autoStopMinutes",
        "botId",
        "timeoutSeconds",
      ])
      for (const command of fake.log.commands) {
        expect(Object.keys(command.options)).toEqual(["timeoutSeconds"])
      }
      expect(JSON.stringify(fake.log)).not.toContain("s3cret-value")
    })

    it("read, write and list files", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { readFile, writeFile, listFiles } = sandboxTools(context(bot), fake)

      expect(await call(writeFile, { path: "notes/todo.md", content: "- one\n" })).toEqual({
        saved: "notes/todo.md",
        bytes: 6,
      })
      expect(await call(readFile, { path: "notes/todo.md" })).toMatchObject({
        path: "notes/todo.md",
        content: "- one\n",
        truncated: false,
      })
      expect(await call(listFiles, { path: "notes" })).toMatchObject({
        entries: [{ name: "todo.md", type: "file", size: 6 }],
        truncated: false,
      })
      // No path means the home folder.
      expect(await call(listFiles, {})).toMatchObject({ path: "." })
    })

    it("refuse bad paths, oversized files and binary files", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { readFile, writeFile, listFiles } = sandboxTools(context(bot), fake)

      for (const path of ["", "a\0b", "x".repeat(MAX_PATH_CHARS + 1)]) {
        expect(await call(readFile, { path }), path.slice(0, 10)).toHaveProperty("error")
        expect(
          await call(writeFile, { path, content: "x" }),
          path.slice(0, 10)
        ).toHaveProperty("error")
      }
      expect(await call(listFiles, { path: "a\0b" })).toHaveProperty("error")

      expect(
        await call(writeFile, { path: "big.txt", content: "x".repeat(MAX_FILE_BYTES + 1) })
      ).toEqual({ error: expect.stringContaining("limit") })
      expect(fake.log.created).toHaveLength(0)

      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
      fake.boxes.get(made.sandboxId)!.files.set("bin.dat", Buffer.from([1, 2, 0, 3]))
      fake.boxes
        .get(made.sandboxId)!
        .files.set("huge.txt", Buffer.alloc(MAX_FILE_BYTES + 1, 97))

      expect(await call(readFile, { path: "bin.dat" })).toEqual({
        error: expect.stringContaining("binary"),
      })
      expect(await call(readFile, { path: "huge.txt" })).toEqual({
        error: expect.stringContaining("limit"),
      })
      expect(await call(readFile, { path: "missing.txt" })).toEqual({
        error: "That file doesn't exist.",
      })
    })

    it("turn provider failures into short errors without passing on internals", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const leaky = Object.assign(Object.create(fake), {
        exec: async (id: string, command: string, options: never) => {
          if (command === "id -u") return fake.exec(id, command, options)
          throw new Error("connect ECONNREFUSED 10.0.0.5:2375 key=abc123")
        },
      }) as typeof fake
      const { bash } = sandboxTools(context(bot), leaky)

      const result = await call(bash, { command: "echo hi" })

      expect(result).toEqual({ error: "The command couldn't be run." })
      expect(JSON.stringify(result)).not.toContain("10.0.0.5")
    })

    it("only ever act on the run's own bot", async () => {
      const fake = fakeSandbox()
      const mine = await freshBot()
      // A run for a bot its user doesn't own can't get a sandbox.
      const { bash } = sandboxTools(
        { userId: owner, botId: strangerBot.id, runId: "r", plan: "pro" as const },
        fake
      )

      expect(await call(bash, { command: "echo hi" })).toEqual({
        error: "That bot doesn't exist.",
      })
      expect(fake.log.created).toHaveLength(0)
      expect(mine.id).not.toBe(strangerBot.id)
    })
  })

  describe("reset", () => {
    it("deletes the sandbox and forgets it, and the next use starts empty", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { writeFile } = sandboxTools({ userId: owner, botId: bot.id, runId: "r", plan: "pro" as const }, fake)
      await call(writeFile, { path: "keep.txt", content: "precious" })
      const first = await recordedSandbox(bot.id)

      expect(await resetSandbox(owner, bot.id, { provider: fake })).toEqual({ ok: true })

      expect(fake.log.deleted).toEqual([first])
      expect(await recordedSandbox(bot.id)).toBeNull()

      const second = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      expect(second.ok && second.sandboxId).not.toBe(first)
      expect(fake.boxes.get(second.ok ? second.sandboxId : "")?.files.size).toBe(0)
    })

    it("does nothing for a bot with no sandbox, and refuses someone else's", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()

      expect(await resetSandbox(owner, bot.id, { provider: fake })).toEqual({ ok: true })
      expect(fake.log.deleted).toHaveLength(0)

      const made = await getOrCreateSandbox(stranger, strangerBot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
      expect(await resetSandbox(owner, strangerBot.id, { provider: fake })).toMatchObject({
        ok: false,
        code: "not_found",
      })
      expect(fake.log.deleted).toHaveLength(0)
      expect(await recordedSandbox(strangerBot.id)).toBe(made.sandboxId)
      await setRecordedSandbox(strangerBot.id, null)
    })

    it("keeps the record when the sandbox couldn't be deleted", async () => {
      const fake = fakeSandbox({ failDeleteFor: () => true })
      const bot = await freshBot()
      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)

      const result = await resetSandbox(owner, bot.id, { provider: fake })

      expect(result).toMatchObject({ ok: false, code: "failed" })
      expect(await recordedSandbox(bot.id)).toBe(made.sandboxId)
    })

    it("works when the sandbox is already gone at the provider", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
      fake.vanish(made.sandboxId)

      expect(await resetSandbox(owner, bot.id, { provider: fake })).toEqual({ ok: true })
      expect(await recordedSandbox(bot.id)).toBeNull()
    })

    it("waits out a live creation, and clears a dead one", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()

      const live = `pending:${Date.now()}:live0003`
      await setRecordedSandbox(bot.id, live)
      expect(await resetSandbox(owner, bot.id, { provider: fake })).toMatchObject({
        ok: false,
        code: "busy",
      })
      expect(await recordedSandbox(bot.id)).toBe(live)

      await setRecordedSandbox(bot.id, `pending:${Date.now() - 10 * 60_000}:dead0003`)
      fake.plantOrphan(bot.id)
      expect(await resetSandbox(owner, bot.id, { provider: fake })).toEqual({ ok: true })
      expect(await recordedSandbox(bot.id)).toBeNull()
      expect(fake.liveFor(bot.id)).toBe(0)
    })

    it("is available to the owner only, through the action", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const bot = await freshBot()
      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)

      expect(await resetSandboxAction(bot.id)).toEqual({
        error: "You need to be signed in.",
      })
      signInAs(stranger)
      expect(await resetSandboxAction(bot.id)).toEqual({ error: "That bot doesn't exist." })
      expect(await resetSandboxAction("x".repeat(65))).toEqual({
        error: "That bot doesn't exist.",
      })
      expect(await recordedSandbox(bot.id)).toBe(made.sandboxId)

      signInAs(owner)
      expect(await resetSandboxAction(bot.id)).toEqual({ ok: true })
      expect(await recordedSandbox(bot.id)).toBeNull()
    })
  })

  describe("status", () => {
    it("reports where the sandbox stands, and never throws", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()

      expect(await getSandboxStatus(owner, bot.id, { provider: null })).toEqual({
        configured: false,
      })
      expect(await getSandboxStatus(owner, bot.id, { provider: fake })).toEqual({
        configured: true,
        state: "none",
      })

      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
      const state = async () =>
        (await getSandboxStatus(owner, bot.id, { provider: fake }))!

      expect(await state()).toEqual({ configured: true, state: "running" })
      fake.switchOff(made.sandboxId)
      expect(await state()).toEqual({ configured: true, state: "stopped" })
      fake.breakIt(made.sandboxId)
      expect(await state()).toEqual({ configured: true, state: "error" })
      fake.vanish(made.sandboxId)
      expect(await state()).toEqual({ configured: true, state: "none" })

      const unreachable = Object.assign(Object.create(fake), {
        status: async () => {
          throw new Error("network down")
        },
      }) as typeof fake
      expect(await getSandboxStatus(owner, bot.id, { provider: unreachable })).toEqual({
        configured: true,
        state: "unknown",
      })

      await setRecordedSandbox(bot.id, `pending:${Date.now()}:live0004`)
      expect(await state()).toEqual({ configured: true, state: "starting" })

      expect(await getSandboxStatus(owner, strangerBot.id, { provider: fake })).toBeNull()
    })
  })

  describe("deleting a bot", () => {
    it("deletes its sandbox, chats and memory with it", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
      const chatId = await newChat(owner, bot.id)
      await writeMemory(owner, bot.id, {
        path: "index.md",
        content: "x",
        expectedVersion: null,
      })

      expect(await removeBot(owner, bot.id, { provider: fake })).toEqual({ ok: true })

      expect(fake.log.deleted).toEqual([made.sandboxId])
      expect(await db.select().from(bots).where(eq(bots.id, bot.id))).toEqual([])
      expect(await db.select().from(chats).where(eq(chats.id, chatId))).toEqual([])
      expect(
        await db.select().from(botMemoryFiles).where(eq(botMemoryFiles.botId, bot.id))
      ).toEqual([])
    })

    it("keeps the bot if its sandbox can't be removed", async () => {
      const fake = fakeSandbox({ failDeleteFor: () => true })
      const bot = await freshBot()
      const made = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)

      const result = await removeBot(owner, bot.id, { provider: fake })

      expect(result).toMatchObject({ ok: false, code: "failed" })
      expect(await recordedSandbox(bot.id)).toBe(made.sandboxId)
      expect(await db.select().from(bots).where(eq(bots.id, bot.id))).toHaveLength(1)
    })

    it("deletes a bot that never had a sandbox, and one whose provider is gone", async () => {
      const fake = fakeSandbox()
      const plain = await freshBot()
      expect(await removeBot(owner, plain.id, { provider: fake })).toEqual({ ok: true })
      expect(fake.log.deleted).toHaveLength(0)

      // The key was removed after a sandbox was made: the bot can still go,
      // and the leftover sandbox is logged for removal by hand.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const orphaned = await freshBot()
      await setRecordedSandbox(orphaned.id, "box_left_behind")
      expect(await removeBot(owner, orphaned.id, { provider: null })).toEqual({ ok: true })
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("box_left_behind"))
    })

    it("refuses someone else's bot and touches nothing", async () => {
      const fake = fakeSandbox()
      const made = await getOrCreateSandbox(stranger, strangerBot.id, { plan: "pro", provider: fake })
      if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)

      expect(await removeBot(owner, strangerBot.id, { provider: fake })).toMatchObject({
        ok: false,
        code: "not_found",
      })

      expect(fake.log.deleted).toHaveLength(0)
      expect(await db.select().from(bots).where(eq(bots.id, strangerBot.id))).toHaveLength(1)
      await setRecordedSandbox(strangerBot.id, null)
    })

    it("stops a reply that is being written for it", async () => {
      const queue = fakeRunQueue({ autoRun: false })
      overrideProviders({ runQueue: queue })
      const fake = fakeSandbox()
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId)

      expect(await removeBot(sender, bot.id, { provider: fake })).toEqual({ ok: true })

      expect(queue.cancelled).toHaveLength(1)
      expect(await db.select().from(runs).where(eq(runs.id, run.runId))).toEqual([])
    })

    it("is available to the owner only, through the action", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const bot = await freshBot()

      expect(await deleteBot(bot.id)).toEqual({ error: "You need to be signed in." })
      signInAs(stranger)
      expect(await deleteBot(bot.id)).toEqual({ error: "That bot doesn't exist." })
      expect(await deleteBot("x".repeat(65))).toEqual({ error: "That bot doesn't exist." })
      expect(await db.select().from(bots).where(eq(bots.id, bot.id))).toHaveLength(1)

      signInAs(owner)
      expect(await deleteBot(bot.id)).toEqual({ ok: true })
      expect(await db.select().from(bots).where(eq(bots.id, bot.id))).toEqual([])
    })
  })

  describe("in a reply", () => {
    const toolParts = (parts: { type: string }[]) =>
      parts.filter((part): part is ToolPart => part.type === "tool")

    it("makes no sandbox until a tool needs one", async () => {
      const fake = fakeSandbox()
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: fake })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Just chat with me")

      const model = fakeModel([{ text: ["Sure."] }])
      await executeRun(run.runId, { ...FAST, model })

      // The tools were offered, and the prompt says so, but nothing was made.
      expect(model.doStreamCalls[0].tools?.map((t) => t.name)).toEqual(
        expect.arrayContaining(["bash", "readFile", "writeFile", "listFiles"])
      )
      expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain("You have a sandbox")
      expect(fake.log.created).toHaveLength(0)
      expect(await recordedSandbox(bot.id)).toBeNull()
    })

    it("makes one on first use, shows the calls as cards, and answers with the output", async () => {
      const fake = fakeSandbox()
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: fake })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Save a note and read it back")

      const model = fakeModel([
        { toolCalls: [{ name: "writeFile", input: { path: "n.txt", content: "hello" } }] },
        { toolCalls: [{ name: "bash", input: { command: "cat n.txt" } }] },
        // Input the tool doesn't accept: an error card, and the run goes on.
        { toolCalls: [{ name: "bash", input: { command: "echo x", timeoutSeconds: 9999 } }] },
        { text: ["It says hello."] },
      ])
      const result = await executeRun(run.runId, { ...FAST, model })

      expect(result.status).toBe("done")
      expect(fake.log.created).toHaveLength(1)
      const { replies } = await readChat(chatId)
      const tools = toolParts(replies[0].parts)
      expect(tools.map((t) => [t.name, t.state])).toEqual([
        ["writeFile", "done"],
        ["bash", "done"],
        ["bash", "error"],
      ])
      expect(tools[1].output).toMatchObject({ exitCode: 0, output: "hello" })
      expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain("hello")
    })

    it("two replies for the same bot at once share one sandbox", async () => {
      const fake = fakeSandbox({ createDelayMs: 300 })
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: fake })
      const bot = await freshBot(sender)
      const [firstChat, secondChat] = await Promise.all([
        newChat(sender, bot.id),
        newChat(sender, bot.id),
      ])
      const [a, b] = [
        await send(sender, firstChat, "Run one thing"),
        await send(sender, secondChat, "Run another"),
      ]
      const modelFor = () =>
        fakeModel([
          { toolCalls: [{ name: "bash", input: { command: "echo shared" } }] },
          { text: ["Done."] },
        ])

      const results = await Promise.all([
        executeRun(a.run.runId, { ...FAST, model: modelFor() }),
        executeRun(b.run.runId, { ...FAST, model: modelFor() }),
      ])

      expect(results.map((r) => r.status)).toEqual(["done", "done"])
      expect(fake.log.created).toHaveLength(1)
      expect(fake.liveFor(bot.id)).toBe(1)
    })

    it("offers no sandbox tools, and says so, when sandboxes aren't configured", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: null })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Run a script")

      const model = fakeModel([{ text: ["I can't run commands here."] }])
      await executeRun(run.runId, { ...FAST, model })

      const offered = (model.doStreamCalls[0].tools ?? []).map((t) => t.name)
      expect(offered).not.toContain("bash")
      expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
        "You have a sandbox"
      )
    })
  })
})
