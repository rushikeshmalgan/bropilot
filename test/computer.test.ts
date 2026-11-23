import { eq } from "drizzle-orm"
import { afterAll, afterEach, describe, expect, it } from "vitest"

import { GET, POST, SCREEN_URL_LIMIT } from "@/app/api/bots/[id]/screen/route"
import { MAX_STEPS_WITH_COMPUTER, MAX_STEPS_WITH_TOOLS } from "@/lib/ai"
import { executeRun } from "@/lib/agent/execute-run"
import { cancelRun } from "@/lib/agent/run-store"
import {
  COMPUTER_SETTLE_MS,
  MAX_COMPUTER_ACTIONS_PER_RUN,
  STOPPED_MESSAGE,
  computerTools,
} from "@/lib/agent/tools/computer"
import type { ToolPart } from "@/lib/chat-types"
import { db } from "@/lib/db"
import { messages, type Bot } from "@/lib/db/schema"
import {
  VIEWER_URL_SECONDS,
  connectDesktop,
  getDesktopStatus,
} from "@/lib/desktop"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { checkLimit } from "@/lib/rate-limit"
import { getOrCreateSandbox } from "@/lib/sandbox"

import { fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { fakePng, fakeSandbox } from "./fakes/fake-sandbox"
import { cleanupUser, createTestBot, testUserId } from "./helpers/db"
import { newChat, readChat, send, until } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const FAST = { retryBaseMs: 40, progressIntervalMs: 60 }
const PNG = fakePng(1280, 720)

describe("computer use", () => {
  const users: string[] = []
  const newUser = () => {
    const id = testUserId()
    users.push(id)
    return id
  }
  const owner = newUser()
  const stranger = newUser()

  const freshBot = (userId = owner) =>
    createTestBot(userId, { name: `Bot ${Math.random().toString(36).slice(2, 7)}` })

  afterEach(() => {
    resetProviderOverrides()
    signOut()
  })

  afterAll(async () => {
    await Promise.all(users.map(cleanupUser))
  })

  // A bot with a recorded, running sandbox, and optionally a live desktop.
  async function botWithSandbox(
    fake: ReturnType<typeof fakeSandbox>,
    { desktop = false, userId = owner } = {}
  ) {
    const bot = await freshBot(userId)
    const made = await getOrCreateSandbox(userId, bot.id, { plan: "pro", provider: fake })
    if (!made.ok) throw new Error(`setup failed: ${JSON.stringify(made)}`)
    if (desktop) await fake.desktop.start(made.sandboxId)
    return { bot, sandboxId: made.sandboxId }
  }

  describe("the desktop's state", () => {
    it("is decided from the sandbox and the desktop, in order", async () => {
      const fake = fakeSandbox()
      const configured = (state: string, reason?: string) => ({
        configured: true,
        state,
        ...(reason ? { reason } : {}),
      })
      const stateOf = async (bot: Bot) =>
        getDesktopStatus(owner, bot.id, { plan: "pro", provider: fake })

      // Not configured, and someone else's bot.
      const lonely = await freshBot()
      expect(await getDesktopStatus(owner, lonely.id, { plan: "pro", provider: null })).toEqual({
        configured: false,
      })
      const theirs = await freshBot(stranger)
      expect(await getDesktopStatus(owner, theirs.id, { plan: "pro", provider: fake })).toBeNull()

      // No sandbox: stopped, and nothing is made by looking.
      expect(await stateOf(lonely)).toEqual(configured("stopped", "no_sandbox"))
      expect(fake.log.created).toHaveLength(0)

      // Sandbox up, desktop not started; then started.
      const { bot, sandboxId } = await botWithSandbox(fake)
      expect(await stateOf(bot)).toEqual(configured("stopped"))
      await fake.desktop.start(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("live"))

      // The desktop's processes die.
      fake.breakDesktop(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("error", "failed"))

      // The sandbox itself: off, being deleted, broken, gone.
      fake.switchOff(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("stopped"))
      fake.markDeleting(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("deleting"))
      fake.breakIt(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("error", "failed"))
      fake.vanish(sandboxId)
      expect(await stateOf(bot)).toEqual(configured("stopped", "no_sandbox"))
    })

    it("treats a creation under way as starting, and an unreachable service as an error", async () => {
      const fake = fakeSandbox()
      const { bot, sandboxId } = await botWithSandbox(fake)
      const { db: database } = { db }
      await database
        .update((await import("@/lib/db/schema")).bots)
        .set({ sandboxId: `pending:${Date.now()}:abc12345` })
        .where(eq((await import("@/lib/db/schema")).bots.id, bot.id))
      expect(await getDesktopStatus(owner, bot.id, { plan: "pro", provider: fake })).toEqual({
        configured: true,
        state: "starting",
      })

      await database
        .update((await import("@/lib/db/schema")).bots)
        .set({ sandboxId })
        .where(eq((await import("@/lib/db/schema")).bots.id, bot.id))
      const down = Object.assign(Object.create(fake), {
        status: async () => {
          throw new Error("network down")
        },
      }) as typeof fake
      expect(await getDesktopStatus(owner, bot.id, { plan: "pro", provider: down })).toEqual({
        configured: true,
        state: "error",
        reason: "unreachable",
      })
    })

    it("replaces a sandbox that is being deleted instead of using it", async () => {
      const fake = fakeSandbox()
      const { bot, sandboxId } = await botWithSandbox(fake)
      fake.markDeleting(sandboxId)

      const again = await getOrCreateSandbox(owner, bot.id, { plan: "pro", provider: fake })

      expect(again.ok && again.sandboxId).not.toBe(sandboxId)
      expect(fake.log.created).toHaveLength(2)
    })
  })

  describe("connecting", () => {
    it("gives a fresh address only when live, view-only unless control is asked for", async () => {
      const fake = fakeSandbox()
      const { bot, sandboxId } = await botWithSandbox(fake, { desktop: true })

      const viewing = await connectDesktop(owner, bot.id, {}, { plan: "pro", provider: fake })
      const controlling = await connectDesktop(
        owner,
        bot.id,
        { control: true },
        { plan: "pro", provider: fake }
      )

      expect(viewing?.url).toMatch(/^https:\/\/viewer\.example\.invalid\//)
      expect(viewing?.expiresInSeconds).toBe(VIEWER_URL_SECONDS)
      expect(VIEWER_URL_SECONDS).toBe(300)
      expect(viewing?.url).not.toBe(controlling?.url)
      expect(fake.log.viewerUrls.map((u) => u.viewOnly)).toEqual([true, false])
      expect(fake.log.viewerUrls.every((u) => u.expiresInSeconds === 300)).toBe(true)
      // Nothing the browser is given names the sandbox.
      expect(JSON.stringify([viewing, controlling])).not.toContain(sandboxId)
    })

    it("gives no address when the screen isn't live", async () => {
      const fake = fakeSandbox()
      const { bot } = await botWithSandbox(fake)

      const result = await connectDesktop(owner, bot.id, {}, { plan: "pro", provider: fake })

      expect(result).toEqual({ status: { configured: true, state: "stopped" } })
      expect(fake.log.viewerUrls).toHaveLength(0)
    })

    it("wakes a stopped sandbox and its desktop on request, and never creates one", async () => {
      const fake = fakeSandbox()
      const { bot, sandboxId } = await botWithSandbox(fake)
      fake.switchOff(sandboxId)

      const woken = await connectDesktop(owner, bot.id, { start: true }, { plan: "pro", provider: fake })

      expect(woken?.status).toEqual({ configured: true, state: "live" })
      expect(woken?.url).toBeTruthy()
      expect(fake.log.started).toEqual([sandboxId])
      expect(fake.log.desktopStarts).toEqual([sandboxId])

      // A bot with no sandbox: asking to start still makes nothing.
      const none = await freshBot()
      const before = fake.log.created.length
      const result = await connectDesktop(owner, none.id, { start: true }, { plan: "pro", provider: fake })
      expect(result?.status).toEqual({ configured: true, state: "stopped", reason: "no_sandbox" })
      expect(fake.log.created).toHaveLength(before)
    })

    it("reports an error when the desktop can't start, and when the address can't be made", async () => {
      const cannot = fakeSandbox({ desktopCannotStart: true })
      const { bot } = await botWithSandbox(cannot)
      expect(
        (await connectDesktop(owner, bot.id, { start: true }, { plan: "pro", provider: cannot }))?.status
      ).toEqual({ configured: true, state: "error", reason: "failed" })

      const fake = fakeSandbox()
      const live = await botWithSandbox(fake, { desktop: true })
      const noUrl = Object.assign(Object.create(fake), {
        desktop: {
          ...fake.desktop,
          viewerUrl: async () => {
            throw new Error("signing failed key=abc")
          },
        },
      }) as typeof fake
      const result = await connectDesktop(owner, live.bot.id, {}, { plan: "pro", provider: noUrl })
      expect(result).toEqual({
        status: { configured: true, state: "error", reason: "failed" },
      })
    })

    it("refuses someone else's bot", async () => {
      const fake = fakeSandbox()
      const { bot } = await botWithSandbox(fake, { desktop: true, userId: stranger })

      expect(await connectDesktop(owner, bot.id, {}, { plan: "pro", provider: fake })).toBeNull()
      expect(fake.log.viewerUrls).toHaveLength(0)
    })
  })

  describe("the screen route", () => {
    const params = (id: string) => ({ params: Promise.resolve({ id }) })
    const post = (id: string, body?: unknown) =>
      POST(
        new Request("http://test.local/screen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        }),
        params(id)
      )
    const get = (id: string) => GET(new Request("http://test.local/screen"), params(id))

    it("answers only the signed-in owner", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const { bot } = await botWithSandbox(fake, { desktop: true })

      expect((await get(bot.id)).status).toBe(401)
      expect((await post(bot.id, {})).status).toBe(401)

      signInAs(stranger)
      const asStranger = await post(bot.id, {})
      expect(asStranger.status).toBe(404)
      expect((await get(bot.id)).status).toBe(404)
      expect((await get("x".repeat(65))).status).toBe(404)
      expect((await get("no-such-bot")).status).toBe(404)
      // The stranger learned nothing, and no address was made for them.
      expect(JSON.stringify(await asStranger.json())).not.toContain("viewer")
      expect(fake.log.viewerUrls).toHaveLength(0)
    })

    it("GET says where it stands without an address; POST gives one when live", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const { bot, sandboxId } = await botWithSandbox(fake, { desktop: true })
      signInAs(owner)

      const state = await get(bot.id)
      expect(state.status).toBe(200)
      expect(state.headers.get("cache-control")).toBe("no-store")
      expect(await state.json()).toEqual({ configured: true, state: "live" })
      expect(fake.log.viewerUrls).toHaveLength(0)

      const opened = await post(bot.id, { control: false })
      expect(opened.status).toBe(200)
      expect(opened.headers.get("cache-control")).toBe("no-store")
      const body = await opened.json()
      expect(body).toMatchObject({ configured: true, state: "live", expiresInSeconds: 300 })
      expect(body.url).toMatch(/view_only=true/)

      const taken = await (await post(bot.id, { control: true })).json()
      expect(taken.url).toMatch(/view_only=false/)

      // Nothing in any answer can identify the sandbox.
      const everything = JSON.stringify([state, body, taken])
      expect(everything).not.toContain(sandboxId)
      expect(everything.toLowerCase()).not.toContain("sandboxid")
    })

    it("wakes a stopped desktop only when asked, and says so when screens aren't set up", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const { bot } = await botWithSandbox(fake)
      signInAs(owner)

      expect(await (await post(bot.id, {})).json()).toEqual({
        configured: true,
        state: "stopped",
      })
      expect(fake.log.desktopStarts).toHaveLength(0)

      const woken = await (await post(bot.id, { start: true })).json()
      expect(woken).toMatchObject({ state: "live" })
      expect(woken.url).toBeTruthy()

      overrideProviders({ sandbox: null })
      expect(await (await post(bot.id, {})).json()).toEqual({ configured: false })
    })

    it("rejects malformed bodies, and limits how often an address can be asked for", async () => {
      const fake = fakeSandbox()
      overrideProviders({ sandbox: fake })
      const { bot } = await botWithSandbox(fake, { desktop: true })
      signInAs(owner)

      expect((await post(bot.id, "{not json")).status).toBe(400)
      expect((await post(bot.id, "[1,2]")).status).toBe(400)
      expect((await post(bot.id, "42")).status).toBe(400)
      // No body at all means the defaults.
      expect((await post(bot.id)).status).toBe(200)

      // Wrong types are ignored rather than trusted: control must be exactly true.
      await post(bot.id, { control: "true", start: "yes" })
      expect(fake.log.viewerUrls.at(-1)?.viewOnly).toBe(true)

      const hasty = newUser()
      const hastyBot = await freshBot(hasty)
      signInAs(hasty)
      for (let i = 0; i < SCREEN_URL_LIMIT; i++) {
        expect((await post(hastyBot.id, {})).status).toBe(200)
      }
      const limited = await post(hastyBot.id, {})
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
      // Looking at the state isn't limited the same way.
      expect((await get(hastyBot.id)).status).toBe(200)
    })

    it("keeps separate limits separate", () => {
      const key = `k_${Math.random()}`
      for (let i = 0; i < 3; i++) checkLimit("a", key, 3, 60_000, 1000)
      expect(checkLimit("a", key, 3, 60_000, 1001).ok).toBe(false)
      expect(checkLimit("b", key, 3, 60_000, 1001).ok).toBe(true)
      expect(checkLimit("a", key, 3, 60_000, 1000 + 61_000).ok).toBe(true)
    })
  })

  describe("the computer tool", () => {
    const context = (bot: Bot) => ({ userId: owner, botId: bot.id, runId: "r", plan: "pro" as const })
    const call = (
      t: { execute?: unknown },
      input: unknown,
      signal?: AbortSignal
    ) =>
      (t.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
        toolCallId: "t",
        messages: [],
        abortSignal: signal,
      })
    const modelOutput = (t: { toModelOutput?: unknown }, output: unknown) =>
      (t.toModelOutput as (o: unknown) => unknown)({ toolCallId: "t", input: {}, output })

    it("makes the sandbox and starts the desktop on first use, and answers with a screenshot", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })
      expect(fake.log.created).toHaveLength(0)

      const result = (await call(computer, { action: "screenshot" })) as {
        action: string
        screen: { width: number; height: number }
        image: string
      }

      expect(result).toMatchObject({
        action: "screenshot",
        screen: { width: 1280, height: 720 },
        image: PNG,
      })
      expect(fake.log.created).toHaveLength(1)
      expect(fake.log.desktopStarts).toHaveLength(1)

      // A second action doesn't start anything again.
      await call(computer, { action: "screenshot" })
      expect(fake.log.created).toHaveLength(1)
      expect(fake.log.desktopStarts).toHaveLength(1)
    })

    it("shows the model the picture as an image part, and errors as text", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })
      const result = await call(computer, { action: "screenshot" })

      expect(modelOutput(computer, result)).toEqual({
        type: "content",
        value: [
          {
            type: "text",
            text: expect.stringContaining("1280 by 720 pixels"),
          },
          {
            type: "file",
            data: { type: "data", data: PNG },
            mediaType: "image/png",
          },
        ],
      })
      expect(modelOutput(computer, { error: "Nope." })).toEqual({
        type: "json",
        value: { error: "Nope." },
      })
    })

    it("does each action it is asked for, then looks at the screen", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })

      await call(computer, { action: "click", x: 100, y: 200 })
      await call(computer, { action: "double_click", x: 5, y: 6, button: "right" })
      await call(computer, { action: "move", x: 7, y: 8 })
      await call(computer, { action: "type", text: "hello" })
      await call(computer, { action: "key", key: "Return" })
      await call(computer, { action: "scroll", x: 9, y: 10, direction: "down" })
      await call(computer, { action: "scroll", x: 9, y: 10, direction: "up", amount: 7 })

      const acts = fake.log.desktopActions.filter((a) => a.type !== "screenshot")
      expect(acts).toEqual([
        { type: "click", args: [100, 200, { button: "left", double: false }] },
        { type: "click", args: [5, 6, { button: "right", double: true }] },
        { type: "move", args: [7, 8] },
        { type: "type", args: ["hello"] },
        { type: "press", args: ["Return"] },
        { type: "scroll", args: [9, 10, "down", 3] },
        { type: "scroll", args: [9, 10, "up", 7] },
      ])
      // Every one of the seven was followed by a screenshot.
      expect(fake.log.desktopActions.filter((a) => a.type === "screenshot")).toHaveLength(7)
    })

    it("pauses after an action, before looking", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 250 })
      await call(computer, { action: "screenshot" })

      const started = Date.now()
      await call(computer, { action: "click", x: 1, y: 1 })

      expect(Date.now() - started).toBeGreaterThanOrEqual(240)
      expect(COMPUTER_SETTLE_MS).toBeGreaterThanOrEqual(300)
    })

    it("refuses incomplete or impossible actions without touching the screen", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })
      await call(computer, { action: "screenshot" })
      const before = fake.log.desktopActions.length

      for (const input of [
        { action: "click" },
        { action: "click", x: 5 },
        { action: "move", y: 5 },
        { action: "type" },
        { action: "type", text: "" },
        { action: "key" },
        { action: "scroll", x: 1, y: 1 },
        { action: "scroll", direction: "up" },
        // Outside the 1280 by 720 screen seen in the screenshot.
        { action: "click", x: 1280, y: 10 },
        { action: "click", x: 10, y: 720 },
        { action: "scroll", x: 5000, y: 5, direction: "down" },
      ]) {
        expect(await call(computer, input), JSON.stringify(input)).toHaveProperty("error")
      }
      expect(await call(computer, { action: "click", x: 5000, y: 5 })).toEqual({
        error: "That point is outside the screen, which is 1280 by 720 pixels.",
      })
      expect(fake.log.desktopActions).toHaveLength(before)

      // A key the screen doesn't accept comes back as a short error.
      expect(await call(computer, { action: "key", key: "NotAKey" })).toEqual({
        error: "That key wasn't accepted.",
      })
    })

    it("stops after its action limit, counting failures too", async () => {
      const fake = fakeSandbox()
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, {
        settleMs: 0,
        maxActions: 3,
      })

      await call(computer, { action: "screenshot" })
      await call(computer, { action: "click" }) // fails: no x, y
      await call(computer, { action: "click", x: 1, y: 1 })
      const refused = await call(computer, { action: "click", x: 2, y: 2 })

      expect(refused).toEqual({ error: expect.stringContaining("used its 3 screen actions") })
      expect(fake.log.desktopActions.filter((a) => a.type === "click")).toHaveLength(1)
      expect(MAX_COMPUTER_ACTIONS_PER_RUN).toBe(20)
    })

    it("doesn't act once the reply has been stopped, or screenshot after it", async () => {
      const fake = fakeSandbox({ desktopActionDelayMs: 150 })
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })
      await call(computer, { action: "screenshot" })

      // Already stopped: nothing happens at all.
      const stopped = new AbortController()
      stopped.abort()
      const before = fake.log.desktopActions.length
      expect(await call(computer, { action: "click", x: 1, y: 1 }, stopped.signal)).toEqual({
        error: STOPPED_MESSAGE,
      })
      expect(fake.log.desktopActions).toHaveLength(before)

      // Stopped while a click is on its way: the click lands, nothing follows.
      const midway = new AbortController()
      const pending = call(computer, { action: "click", x: 2, y: 2 }, midway.signal)
      setTimeout(() => midway.abort(), 40)
      expect(await pending).toEqual({ error: STOPPED_MESSAGE })
      const after = fake.log.desktopActions.slice(before)
      expect(after.map((a) => a.type)).toEqual(["click"])
    })

    it("gives a short error when the desktop can't start", async () => {
      const fake = fakeSandbox({ desktopCannotStart: true })
      const bot = await freshBot()
      const { computer } = computerTools(context(bot), fake, { settleMs: 0 })

      expect(await call(computer, { action: "screenshot" })).toEqual({
        error: "The desktop didn't start.",
      })
    })

    it("can't be pointed at another user's bot", async () => {
      const fake = fakeSandbox()
      const theirs = await freshBot(stranger)
      const { computer } = computerTools(
        { userId: owner, botId: theirs.id, runId: "r", plan: "pro" as const },
        fake,
        { settleMs: 0 }
      )

      expect(await call(computer, { action: "screenshot" })).toEqual({
        error: "That bot doesn't exist.",
      })
      expect(fake.log.created).toHaveLength(0)
    })
  })

  describe("in a reply", () => {
    const sender = newUser()
    const toolParts = (parts: { type: string }[]) =>
      parts.filter((part): part is ToolPart => part.type === "tool")

    async function start(fake: ReturnType<typeof fakeSandbox>, queueOptions = {}) {
      const queue = fakeRunQueue({ autoRun: false, ...queueOptions })
      overrideProviders({ runQueue: queue, sandbox: fake })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Open the browser")
      return { queue, bot, chatId, runId: run.runId }
    }

    it("offers the tool, describes it, and allows more steps than an ordinary tool reply", async () => {
      const fake = fakeSandbox()
      const { runId } = await start(fake)

      const model = fakeModel([{ text: ["Hello."] }])
      await executeRun(runId, { ...FAST, model })

      expect(model.doStreamCalls[0].tools?.map((t) => t.name)).toContain("computer")
      const prompt = JSON.stringify(model.doStreamCalls[0].prompt)
      expect(prompt).toContain("desktop screen")
      expect(prompt).toContain("Never type a password")
      expect(prompt).toContain("what is on the screen")
      expect(MAX_STEPS_WITH_COMPUTER).toBeGreaterThan(MAX_STEPS_WITH_TOOLS)
      // Offering a tool makes nothing: no sandbox until it is used.
      expect(fake.log.created).toHaveLength(0)
    })

    it("offers no screen when sandboxes aren't configured", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: null })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Use the screen")

      const model = fakeModel([{ text: ["I have no screen here."] }])
      await executeRun(run.runId, { ...FAST, model })

      expect((model.doStreamCalls[0].tools ?? []).map((t) => t.name)).not.toContain(
        "computer"
      )
      expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain("desktop screen")
    })

    it("shows the model each screenshot but never saves one", async () => {
      const fake = fakeSandbox()
      const { chatId, runId } = await start(fake)

      const model = fakeModel([
        { toolCalls: [{ name: "computer", input: { action: "screenshot" } }] },
        { toolCalls: [{ name: "computer", input: { action: "click", x: 10, y: 20 } }] },
        { text: ["I opened it."] },
      ])
      const progress: string[] = []
      const result = await executeRun(runId, {
        ...FAST,
        model,
        onProgress: (update) => progress.push(JSON.stringify(update)),
      })

      expect(result.status).toBe("done")
      const { replies } = await readChat(chatId)
      const cards = toolParts(replies[0].parts)
      expect(cards.map((c) => [c.name, c.state])).toEqual([
        ["computer", "done"],
        ["computer", "done"],
      ])
      expect(cards[1].input).toEqual({ action: "click", x: 10, y: 20 })
      expect(cards[0].output).toMatchObject({
        action: "screenshot",
        screen: { width: 1280, height: 720 },
        image: "(screenshot not saved)",
      })

      // The picture is nowhere in what was saved, or in what was streamed live...
      const rows = await db.select().from(messages).where(eq(messages.chatId, chatId))
      expect(JSON.stringify(rows)).not.toContain(PNG)
      expect(progress.join("")).not.toContain(PNG)

      // ...but the model did receive it, as an image, on the step after.
      const toolTurn = model.doStreamCalls[1].prompt.find((m) => m.role === "tool")
      expect(JSON.stringify(toolTurn)).toContain("image/png")
    })

    it("stops a bot that only ever clicks: 20 actions, then 24 steps", async () => {
      const fake = fakeSandbox()
      const { chatId, runId } = await start(fake)

      const model = fakeModel([
        { toolCalls: [{ name: "computer", input: { action: "click", x: 1, y: 1 } }] },
      ])
      const result = await executeRun(runId, { ...FAST, model })

      expect(result.status).toBe("done")
      expect(model.callCount()).toBe(MAX_STEPS_WITH_COMPUTER)
      expect(fake.log.desktopActions.filter((a) => a.type === "click")).toHaveLength(
        MAX_COMPUTER_ACTIONS_PER_RUN
      )
      const cards = toolParts((await readChat(chatId)).replies[0].parts)
      expect(cards).toHaveLength(MAX_STEPS_WITH_COMPUTER)
      expect(cards.at(-1)).toMatchObject({
        state: "error",
        output: { error: expect.stringContaining("used its 20 screen actions") },
      })
    }, 120_000)

    it("Stop ends it: no more clicks land, and the run is cancelled", async () => {
      const fake = fakeSandbox({ desktopActionDelayMs: 350 })
      const queue = fakeRunQueue({
        deps: {
          ...FAST,
          model: fakeModel([
            { toolCalls: [{ name: "computer", input: { action: "click", x: 3, y: 3 } }] },
          ]),
        },
      })
      overrideProviders({ runQueue: queue, sandbox: fake })
      const bot = await freshBot(sender)
      const chatId = await newChat(sender, bot.id)
      const { run } = await send(sender, chatId, "Click around")

      const clicks = () => fake.log.desktopActions.filter((a) => a.type === "click").length
      await until(async () => clicks() >= 1, 60_000)
      const stopped = await cancelRun(sender, run.runId)
      expect(stopped?.status).toBe("cancelled")
      const atStop = clicks()

      await queue.settle()

      // At most the action already on its way landed after Stop.
      expect(clicks()).toBeLessThanOrEqual(atStop + 1)
      expect(clicks()).toBeLessThan(MAX_COMPUTER_ACTIONS_PER_RUN)
      expect((await readChat(chatId)).runs[0].status).toBe("cancelled")
    }, 120_000)
  })
})
