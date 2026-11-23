import { eq, sql } from "drizzle-orm"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { POST as postChat } from "@/app/api/chat/route"
import { GET as getScreen, POST as postScreen } from "@/app/api/bots/[id]/screen/route"
import {
  createBot,
  createChat,
  deleteMemoryFile,
  saveMemoryFile,
} from "@/lib/actions"
import { executeRun } from "@/lib/agent/execute-run"
import { cancelRun } from "@/lib/agent/run-store"
import { startRun } from "@/lib/agent/start-run"
import { computerTools } from "@/lib/agent/tools/computer"
import { sandboxTools } from "@/lib/agent/tools/sandbox"
import {
  clerkPlanResolver,
  getPlan,
  overridePlanResolver,
} from "@/lib/billing"
import { removeBot } from "@/lib/bot-delete"
import { db } from "@/lib/db"
import { bots, runs } from "@/lib/db/schema"
import { connectDesktop, ensureDesktop, getDesktopStatus } from "@/lib/desktop"
import { readMemory, writeMemory } from "@/lib/memory"
import {
  PLANS,
  READ_ONLY_BOT_MESSAGE,
  monthKey,
  planLimits,
} from "@/lib/plans"
import { overrideProviders, resetProviderOverrides } from "@/lib/providers"
import { getOrCreateSandbox } from "@/lib/sandbox"
import {
  activeBotIds,
  countBots,
  createBotWithinLimit,
  getUsage,
  getUsageSummary,
  recordRunUsage,
  releaseRun,
  reserveRun,
} from "@/lib/usage"

import { apiError, fakeModel } from "./fakes/fake-model"
import { fakeRunQueue } from "./fakes/fake-run-queue"
import { fakeSandbox } from "./fakes/fake-sandbox"
import { cleanupUser, createTestBot, setUsage, testUserId } from "./helpers/db"
import { newChat, readChat, send } from "./helpers/runs"
import { signInAs, signOut } from "./helpers/session"

const FAST = { retryBaseMs: 40, progressIntervalMs: 60 }
const THIS_MONTH = monthKey()

describe("plans and usage", () => {
  const users: string[] = []
  const newUser = () => {
    const id = testUserId()
    users.push(id)
    return id
  }

  afterEach(() => {
    resetProviderOverrides()
    signOut()
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await Promise.all(users.map(cleanupUser))
  })

  const asFree = () => overridePlanResolver({ getPlan: async () => "free" })

  describe("the plans", () => {
    it("are defined in one place, with the limits the brief gave", () => {
      expect(PLANS.free).toMatchObject({
        maxBots: 3,
        sandboxes: false,
        computerUse: false,
        runsPerMonth: 50,
        tokensPerMonth: 200_000,
      })
      expect(PLANS.pro).toMatchObject({
        maxBots: 20,
        sandboxes: true,
        computerUse: true,
        runsPerMonth: 1000,
        tokensPerMonth: 5_000_000,
      })
      // Anything unrecognised gets the lowest plan, never a higher one.
      for (const odd of ["enterprise", "", null, undefined, 7, "PRO"]) {
        expect(planLimits(odd), String(odd)).toBe(PLANS.free)
      }
    })

    it("count months in UTC, so the allowance resets at the same instant for everyone", () => {
      expect(monthKey(new Date("2026-11-30T23:59:59.999Z"))).toBe("2026-11")
      expect(monthKey(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12")
      expect(monthKey(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01")
    })
  })

  describe("which plan a user is on", () => {
    it("is Free by default and Pro on request in development", async () => {
      overridePlanResolver(null)
      expect(await getPlan("anyone")).toBe("free")

      vi.stubEnv("BILLING_STUB_PLAN", "pro")
      expect(await getPlan("anyone")).toBe("pro")

      vi.stubEnv("BILLING_STUB_PLAN", "enterprise")
      expect(await getPlan("anyone")).toBe("free")
    })

    it("never honours the development stand-in in production", async () => {
      overridePlanResolver(null)
      vi.stubEnv("NODE_ENV", "production")
      vi.stubEnv("BILLING_STUB_PLAN", "pro")
      const user = newUser()

      // Production reads Clerk. A user with no paid plan is Free whatever the
      // leftover setting says.
      signInAs(user, [])
      expect(await getPlan(user)).toBe("free")

      // And one with the paid plan is Pro, by Clerk's answer.
      signInAs(user, ["pro"])
      expect(await getPlan(user)).toBe("pro")
    })

    it("reads Clerk Billing with has({ plan }) for the signed-in user only", async () => {
      const user = newUser()
      const other = newUser()

      signInAs(user, ["pro"])
      expect(await clerkPlanResolver.getPlan(user)).toBe("pro")
      // Asked about someone else, there is nothing to read: Free.
      expect(await clerkPlanResolver.getPlan(other)).toBe("free")

      signInAs(user, ["some-other-plan"])
      expect(await clerkPlanResolver.getPlan(user)).toBe("free")

      signOut()
      expect(await clerkPlanResolver.getPlan(user)).toBe("free")
    })

    it("falls back to Free, and says so in the log, when the check itself fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const user = newUser()
      signInAs(user, ["__throws__"])

      expect(await clerkPlanResolver.getPlan(user)).toBe("free")
      expect(logged).toHaveBeenCalledWith(
        "Couldn't check the plan with Clerk:",
        "Error"
      )
    })

    it("can use the real check in development when asked to", async () => {
      overridePlanResolver(null)
      vi.stubEnv("BILLING_PROVIDER", "clerk")
      vi.stubEnv("BILLING_STUB_PLAN", "pro")
      const user = newUser()

      signInAs(user, [])
      expect(await getPlan(user)).toBe("free")
      signInAs(user, ["pro"])
      expect(await getPlan(user)).toBe("pro")
    })
  })

  describe("the monthly allowance", () => {
    it("lets exactly the allowed number of parallel replies through", async () => {
      const user = newUser()
      const limit = PLANS.free.runsPerMonth
      await setUsage(user, THIS_MONTH, { runs: limit - 2 })

      const results = await Promise.all(
        Array.from({ length: 8 }, () => reserveRun(user, "free"))
      )

      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(results.filter((r) => !r.ok && r.reason === "runs")).toHaveLength(6)
      expect((await getUsage(user)).runs).toBe(limit)
    })

    it("refuses once the month's tokens are used up, even with replies to spare", async () => {
      const user = newUser()
      await setUsage(user, THIS_MONTH, {
        runs: 3,
        inputTokens: 120_000,
        outputTokens: PLANS.free.tokensPerMonth - 120_000,
      })

      expect(await reserveRun(user, "free")).toEqual({ ok: false, reason: "tokens" })
      // Pro has far more room for the same use.
      expect(await reserveRun(user, "pro")).toMatchObject({ ok: true })
    })

    it("starts a new count each month", async () => {
      const user = newUser()
      await setUsage(user, "2026-10", { runs: PLANS.free.runsPerMonth })

      const november = await reserveRun(user, "free", new Date("2026-11-02T10:00:00Z"))
      const october = await reserveRun(user, "free", new Date("2026-10-20T10:00:00Z"))

      expect(november).toEqual({ ok: true, month: "2026-11" })
      expect(october).toEqual({ ok: false, reason: "runs" })
    })

    it("gives a reply back, but never goes below zero", async () => {
      const user = newUser()
      expect(await reserveRun(user, "free")).toMatchObject({ ok: true })
      expect((await getUsage(user)).runs).toBe(1)

      await releaseRun(user, THIS_MONTH)
      await releaseRun(user, THIS_MONTH)
      expect((await getUsage(user)).runs).toBe(0)
    })
  })

  describe("how many bots", () => {
    it("lets exactly the allowed number of parallel creations through", async () => {
      const user = newUser()
      const values = (i: number) => ({
        name: `Bot ${i}`,
        job: "Tester",
        instructions: null,
        avatar: "ada",
      })

      const free = await Promise.all(
        Array.from({ length: 8 }, (_, i) => createBotWithinLimit(user, values(i), "free"))
      )
      expect(free.filter(Boolean)).toHaveLength(PLANS.free.maxBots)
      expect(await countBots(user)).toBe(PLANS.free.maxBots)

      const pro = newUser()
      const paid = await Promise.all(
        Array.from({ length: 24 }, (_, i) => createBotWithinLimit(pro, values(i), "pro"))
      )
      expect(paid.filter(Boolean)).toHaveLength(PLANS.pro.maxBots)
      expect(await countBots(pro)).toBe(PLANS.pro.maxBots)
    }, 120_000)

    it("refuses a fourth bot on Free with an upgrade message, and allows it on Pro", async () => {
      const user = newUser()
      signInAs(user)
      asFree()
      const make = (name: string) =>
        createBot({ name, job: "Tester", instructions: "", avatar: "ada" })

      for (const name of ["A", "B", "C"]) {
        expect(await make(name)).toHaveProperty("id")
      }
      const refused = await make("D")
      expect(refused).toEqual({
        error: expect.stringContaining("Upgrade to Pro for up to 20"),
        upgrade: true,
      })
      expect(await countBots(user)).toBe(3)

      overridePlanResolver({ getPlan: async () => "pro" })
      expect(await make("D")).toHaveProperty("id")
      expect(await countBots(user)).toBe(4)
    })

    it("still checks the input the way it did, and the user's sign-in", async () => {
      const user = newUser()
      expect(
        await createBot({ name: "X", job: "Y", instructions: "", avatar: "ada" })
      ).toEqual({ error: "You need to be signed in." })

      signInAs(user)
      expect(
        await createBot({ name: "  ", job: "Y", instructions: "", avatar: "ada" })
      ).toHaveProperty("error")
      expect(
        await createBot({ name: "X", job: "Y", instructions: "x".repeat(2001), avatar: "ada" })
      ).toHaveProperty("error")
      // An older face seed, which isn't one of the 50 names, is still accepted.
      expect(
        await createBot({ name: "Old", job: "Y", instructions: "", avatar: "a3f9c2d1" })
      ).toHaveProperty("id")
    })

    it("tells a Pro user at the limit to delete one, without an upgrade prompt", async () => {
      const user = newUser()
      signInAs(user)
      for (let i = 0; i < PLANS.pro.maxBots; i++) {
        await createBotWithinLimit(
          user,
          { name: `B${i}`, job: "J", instructions: null, avatar: "ada" },
          "pro"
        )
      }

      const refused = await createBot({ name: "Extra", job: "J", instructions: "", avatar: "ada" })

      expect(refused).toEqual({
        error: expect.stringContaining("Delete one to make room"),
        upgrade: false,
      })
    }, 120_000)
  })

  describe("starting a reply", () => {
    // A user with the given number of bots, oldest first.
    async function userWithBots(count: number) {
      const user = newUser()
      const list = []
      for (let i = 0; i < count; i++) {
        list.push(await createTestBot(user, { name: `Bot ${i}` }))
      }
      return { user, bots: list }
    }

    it("refuses a bot the plan no longer covers, and uses none of the allowance", async () => {
      const queue = fakeRunQueue({ autoRun: false })
      overrideProviders({ runQueue: queue })
      const { user, bots: list } = await userWithBots(5)
      expect(await activeBotIds(user, "free")).toEqual(list.slice(0, 3).map((b) => b.id))

      // The oldest three are fine.
      for (const bot of list.slice(0, 3)) {
        const chat = await newChat(user, bot.id)
        expect((await startRun({ userId: user, chatId: chat, text: "Hi", plan: "free" })).ok).toBe(true)
      }
      const before = (await getUsage(user)).runs

      // The two newest are read-only.
      const readOnlyChat = await newChat(user, list[3].id)
      const refused = await startRun({ userId: user, chatId: readOnlyChat, text: "Hi", plan: "free" })

      expect(refused).toMatchObject({
        ok: false,
        status: 403,
        code: "bot_read_only",
        error: READ_ONLY_BOT_MESSAGE,
      })
      expect((await readChat(readOnlyChat)).messages).toHaveLength(0)
      expect((await getUsage(user)).runs).toBe(before)
      expect(queue.enqueued).toHaveLength(3)

      // On Pro the same bot works.
      const allowed = await startRun({ userId: user, chatId: readOnlyChat, text: "Hi", plan: "pro" })
      expect(allowed.ok).toBe(true)
    })

    it("lets exactly the allowed number of parallel replies start", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const { user, bots: list } = await userWithBots(1)
      const chats = await Promise.all(
        Array.from({ length: 8 }, () => newChat(user, list[0].id))
      )
      await setUsage(user, THIS_MONTH, { runs: PLANS.free.runsPerMonth - 2 })

      const results = await Promise.all(
        chats.map((chatId) => startRun({ userId: user, chatId, text: "Hi", plan: "free" }))
      )

      expect(results.filter((r) => r.ok)).toHaveLength(2)
      const refused = results.filter((r) => !r.ok)
      expect(refused).toHaveLength(6)
      expect(refused[0]).toMatchObject({ status: 402, code: "plan_limit", upgrade: true })
      expect((refused[0] as { error: string }).error).toContain("all 50 replies")
      expect((await getUsage(user)).runs).toBe(PLANS.free.runsPerMonth)
      // The refused ones saved nothing.
      const rows = await db
        .select()
        .from(runs)
        .where(sql`chat_id in (${sql.join(chats.map((id) => sql`${id}`), sql`, `)})`)
      expect(rows).toHaveLength(2)
    })

    it("says which limit was hit, and offers no upgrade to a Pro user", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const { user, bots: list } = await userWithBots(1)
      const chat = await newChat(user, list[0].id)

      await setUsage(user, THIS_MONTH, { runs: 1, inputTokens: PLANS.free.tokensPerMonth })
      expect(await startRun({ userId: user, chatId: chat, text: "Hi", plan: "free" })).toMatchObject({
        ok: false,
        status: 402,
        upgrade: true,
        error: expect.stringContaining("200k tokens"),
      })

      await setUsage(user, THIS_MONTH, { runs: PLANS.pro.runsPerMonth })
      const proRefusal = await startRun({ userId: user, chatId: chat, text: "Hi", plan: "pro" })
      expect(proRefusal).toMatchObject({ ok: false, status: 402 })
      expect((proRefusal as { upgrade?: boolean }).upgrade).toBe(false)
      expect((proRefusal as { error: string }).error).not.toContain("Upgrade")
    })

    it("hands the reply back when it can't start: a busy chat, a queue that is down", async () => {
      const { user, bots: list } = await userWithBots(1)
      const chat = await newChat(user, list[0].id)

      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      expect((await startRun({ userId: user, chatId: chat, text: "One", plan: "pro" })).ok).toBe(true)
      expect((await getUsage(user)).runs).toBe(1)

      // The chat is still replying, so this is refused and costs nothing.
      const busy = await startRun({ userId: user, chatId: chat, text: "Two", plan: "pro" })
      expect(busy).toMatchObject({ ok: false, status: 409 })
      expect((await getUsage(user)).runs).toBe(1)

      // A queue that is down fails the reply through no fault of the user.
      const second = await newChat(user, list[0].id)
      overrideProviders({ runQueue: fakeRunQueue({ failEnqueue: true }) })
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      expect((await startRun({ userId: user, chatId: second, text: "Three", plan: "pro" })).ok).toBe(true)
      logged.mockRestore()
      expect((await getUsage(user)).runs).toBe(1)
    })

    it("saves the plan on the run, so the worker needn't ask", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const { user, bots: list } = await userWithBots(1)
      const chat = await newChat(user, list[0].id)

      const started = await startRun({ userId: user, chatId: chat, text: "Hi", plan: "pro" })
      if (!started.ok) throw new Error("setup failed")

      const [row] = await db.select().from(runs).where(eq(runs.id, started.run.runId))
      expect(row.plan).toBe("pro")
    })

    it("answers 402 with an upgrade flag, and 403 for a read-only bot, through the route", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const { user, bots: list } = await userWithBots(4)
      signInAs(user)
      asFree()
      const post = (chatId: string) =>
        postChat(
          new Request("http://test.local/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: chatId, text: "Hi" }),
          })
        )

      const readOnly = await post(await newChat(user, list[3].id))
      expect(readOnly.status).toBe(403)
      expect(await readOnly.json()).toEqual({
        code: "bot_read_only",
        error: READ_ONLY_BOT_MESSAGE,
      })

      await setUsage(user, THIS_MONTH, { runs: PLANS.free.runsPerMonth })
      const full = await post(await newChat(user, list[0].id))
      expect(full.status).toBe(402)
      expect(await full.json()).toMatchObject({ code: "plan_limit", upgrade: true })
    })
  })

  describe("counting what a reply used", () => {
    async function finishedRun(
      steps: Parameters<typeof fakeModel>[0],
      options: { sandbox?: ReturnType<typeof fakeSandbox> } = {}
    ) {
      overrideProviders({
        runQueue: fakeRunQueue({ autoRun: false }),
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      })
      const user = newUser()
      const bot = await createTestBot(user)
      const chat = await newChat(user, bot.id)
      const { run } = await send(user, chat, "Do it")
      const model = fakeModel(steps)
      const result = await executeRun(run.runId, { ...FAST, model })
      return { user, chat, runId: run.runId, result }
    }

    it("adds a reply's tokens once, to the month it started in", async () => {
      const { user, runId } = await finishedRun([{ text: ["Done."] }])

      // One step of the fake model reports 10 tokens in and 5 out.
      expect(await getUsage(user)).toMatchObject({
        runs: 1,
        inputTokens: 10,
        outputTokens: 5,
        sandboxMinutes: 0,
      })

      // Counting again, in any number of ways, changes nothing.
      await recordRunUsage(runId, { inputTokens: 999, outputTokens: 999, sandboxSeconds: 999 })
      await executeRun(runId, { ...FAST, model: fakeModel([{ text: ["again"] }]) })
      expect(await getUsage(user)).toMatchObject({ runs: 1, inputTokens: 10, outputTokens: 5 })
    })

    it("counts a run once however many callers finish it at the same moment", async () => {
      const { user, runId } = await finishedRun([{ text: ["Done."] }])
      await setUsage(user, THIS_MONTH, { runs: 1 })
      await db.execute(sql`update runs set usage_counted_at = null where id = ${runId}`)

      await Promise.all(
        Array.from({ length: 6 }, () =>
          recordRunUsage(runId, { inputTokens: 7, outputTokens: 3, sandboxSeconds: 61 })
        )
      )

      expect(await getUsage(user)).toMatchObject({
        inputTokens: 7,
        outputTokens: 3,
        sandboxMinutes: 2,
      })
    })

    it("ignores a run that hasn't finished", async () => {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }) })
      const user = newUser()
      const bot = await createTestBot(user)
      const chat = await newChat(user, bot.id)
      const { run } = await send(user, chat)

      await recordRunUsage(run.runId, { inputTokens: 50, outputTokens: 50, sandboxSeconds: 600 })

      expect(await getUsage(user)).toMatchObject({ inputTokens: 0, outputTokens: 0, sandboxMinutes: 0 })
      // It can still be counted properly once it is over.
      await executeRun(run.runId, { ...FAST, model: fakeModel([{ text: ["ok"] }]) })
      expect((await getUsage(user)).inputTokens).toBe(10)
    })

    it("attributes tokens to the month the reply started in", async () => {
      const { user, runId } = await finishedRun([{ text: ["Done."] }])
      await setUsage(user, THIS_MONTH, { runs: 1 })
      await db.execute(
        sql`update runs set usage_counted_at = null, created_at = '2026-09-15T12:00:00Z' where id = ${runId}`
      )

      await recordRunUsage(runId, { inputTokens: 40, outputTokens: 2, sandboxSeconds: 0 })

      expect((await getUsage(user, "2026-09")).inputTokens).toBe(40)
      expect((await getUsage(user)).inputTokens).toBe(0)
    })

    it("still counts the reply, but no tokens, when the model fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const { user, result } = await finishedRun([{ error: apiError(400) }])
      logged.mockRestore()

      expect(result.status).toBe("error")
      expect(await getUsage(user)).toMatchObject({ runs: 1, inputTokens: 0, outputTokens: 0 })
    })

    it("adds the sandbox time its tools used, rounded up to whole minutes", async () => {
      const { user } = await finishedRun(
        [
          { toolCalls: [{ name: "bash", input: { command: "echo hi" } }] },
          { text: ["Done."] },
        ],
        { sandbox: fakeSandbox() }
      )

      // Each command counts at least a second; a minute is the smallest unit.
      expect(await getUsage(user)).toMatchObject({ sandboxMinutes: 1 })
    })

    it("a stopped reply is counted when its worker ends, and tokens it never reported count as none", async () => {
      const queue = fakeRunQueue({
        deps: {
          ...FAST,
          model: fakeModel([{ text: Array.from({ length: 300 }, () => "w "), chunkDelayMs: 80 }]),
        },
      })
      overrideProviders({ runQueue: queue })
      const user = newUser()
      const bot = await createTestBot(user)
      const chat = await newChat(user, bot.id)
      const { run } = await send(user, chat)

      await new Promise((resolve) => setTimeout(resolve, 1500))
      await cancelRun(user, run.runId)
      await queue.settle()

      const [row] = await db.select().from(runs).where(eq(runs.id, run.runId))
      expect(row.status).toBe("cancelled")
      expect(row.usageCountedAt).toBeInstanceOf(Date)
      expect(await getUsage(user)).toMatchObject({ runs: 1, inputTokens: 0 })
    }, 90_000)

    it("summarises the month for the sidebar", async () => {
      const user = newUser()
      await createTestBot(user)
      await createTestBot(user)
      await setUsage(user, THIS_MONTH, { runs: 12, inputTokens: 30_000, outputTokens: 10_000 })

      expect(await getUsageSummary(user, "free")).toEqual({
        plan: "Free",
        runs: { used: 12, max: 50 },
        tokens: { used: 40_000, max: 200_000 },
        bots: { used: 2, max: 3 },
      })
      expect((await getUsageSummary(newUser(), "pro")).plan).toBe("Pro")
    })
  })

  describe("what each plan can use", () => {
    async function runWith(plan: "free" | "pro", fake: ReturnType<typeof fakeSandbox>) {
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: fake })
      const user = newUser()
      const bot = await createTestBot(user)
      const chat = await newChat(user, bot.id)
      const { run } = await send(user, chat, "Use your computer", plan)
      const model = fakeModel([{ text: ["Ok."] }])
      await executeRun(run.runId, { ...FAST, model })
      return { user, bot, model }
    }

    it("offers sandbox and screen tools only on Pro, and doesn't mention them on Free", async () => {
      const fake = fakeSandbox()

      const free = await runWith("free", fake)
      const freeTools = (free.model.doStreamCalls[0].tools ?? []).map((t) => t.name)
      expect(freeTools).not.toEqual(expect.arrayContaining(["bash"]))
      for (const name of ["bash", "readFile", "writeFile", "listFiles", "computer"]) {
        expect(freeTools).not.toContain(name)
      }
      // Memory is part of every plan.
      expect(freeTools).toContain("memoryWrite")
      const freePrompt = JSON.stringify(free.model.doStreamCalls[0].prompt)
      expect(freePrompt).not.toContain("You have a sandbox")
      expect(freePrompt).not.toContain("desktop screen")

      const pro = await runWith("pro", fake)
      expect((pro.model.doStreamCalls[0].tools ?? []).map((t) => t.name)).toEqual(
        expect.arrayContaining(["bash", "computer", "memoryWrite"])
      )
    })

    it("uses the plan the reply started with, even if it changes while it runs", async () => {
      const fake = fakeSandbox()
      overrideProviders({ runQueue: fakeRunQueue({ autoRun: false }), sandbox: fake })
      const user = newUser()
      const bot = await createTestBot(user)
      const chat = await newChat(user, bot.id)
      const { run } = await send(user, chat, "Go", "pro")

      // The user downgrades after sending.
      asFree()
      const model = fakeModel([{ text: ["Ok."] }])
      await executeRun(run.runId, { ...FAST, model })

      expect((model.doStreamCalls[0].tools ?? []).map((t) => t.name)).toContain("bash")
      // The next reply, started on Free, is a different matter.
      const next = await newChat(user, bot.id)
      const started = await startRun({ userId: user, chatId: next, text: "Again", plan: "free" })
      if (!started.ok) throw new Error("setup failed")
      const second = fakeModel([{ text: ["Ok."] }])
      await executeRun(started.run.runId, { ...FAST, model: second })
      expect((second.doStreamCalls[0].tools ?? []).map((t) => t.name)).not.toContain("bash")
    })

    it("won't make or use a sandbox on Free, whatever calls for one", async () => {
      const fake = fakeSandbox()
      const user = newUser()
      const bot = await createTestBot(user)

      const direct = await getOrCreateSandbox(user, bot.id, { provider: fake, plan: "free" })
      expect(direct).toMatchObject({ ok: false, code: "plan_limit" })
      expect(direct.ok ? "" : direct.error).toContain("Upgrade to Pro")

      // Even a tool built by hand can't get one.
      const { bash } = sandboxTools({ userId: user, botId: bot.id, runId: "r", plan: "free" }, fake)
      const result = await (bash.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        { command: "echo hi" },
        { toolCallId: "t", messages: [] }
      )
      expect(result).toEqual({ error: expect.stringContaining("part of the Free plan") })
      expect(fake.log.created).toHaveLength(0)

      expect(
        await getOrCreateSandbox(user, bot.id, { provider: fake, plan: "pro" })
      ).toMatchObject({ ok: true })
    })

    it("won't start or show a screen on Free", async () => {
      const fake = fakeSandbox()
      const user = newUser()
      const bot = await createTestBot(user)
      const made = await getOrCreateSandbox(user, bot.id, { provider: fake, plan: "pro" })
      if (!made.ok) throw new Error("setup failed")
      await fake.desktop.start(made.sandboxId)

      // The bot's own use.
      expect(await ensureDesktop(user, bot.id, { provider: fake, plan: "free" })).toMatchObject({
        ok: false,
        code: "plan_limit",
      })
      const { computer } = computerTools(
        { userId: user, botId: bot.id, runId: "r", plan: "free" },
        fake,
        { settleMs: 0 }
      )
      expect(
        await (computer.execute as (i: unknown, o: unknown) => Promise<unknown>)(
          { action: "screenshot" },
          { toolCallId: "t", messages: [] }
        )
      ).toEqual({ error: expect.stringContaining("Using a screen isn't part of the Free plan") })

      // The owner's view: even a live screen isn't shown, and Start does nothing.
      expect(await getDesktopStatus(user, bot.id, { provider: fake, plan: "free" })).toEqual({
        configured: true,
        state: "stopped",
        reason: "plan",
      })
      fake.switchOff(made.sandboxId)
      const connection = await connectDesktop(user, bot.id, { start: true }, { provider: fake, plan: "free" })
      expect(connection).toEqual({ status: { configured: true, state: "stopped", reason: "plan" } })
      expect(fake.log.started).toEqual([])
      expect(fake.log.viewerUrls).toHaveLength(0)

      // The same through the route, for a signed-in Free user.
      overrideProviders({ sandbox: fake })
      signInAs(user)
      asFree()
      const params = { params: Promise.resolve({ id: bot.id }) }
      expect(await (await getScreen(new Request("http://t/s"), params)).json()).toEqual({
        configured: true,
        state: "stopped",
        reason: "plan",
      })
      const posted = await postScreen(
        new Request("http://t/s", { method: "POST", body: JSON.stringify({ start: true }) }),
        params
      )
      expect(await posted.json()).toEqual({ configured: true, state: "stopped", reason: "plan" })
      expect(fake.log.started).toEqual([])
    })
  })

  describe("bots the plan no longer covers", () => {
    it("keeps them, readable but not changeable, and lets them be deleted", async () => {
      const user = newUser()
      const list = []
      for (let i = 0; i < 5; i++) list.push(await createTestBot(user, { name: `Bot ${i}` }))
      const [first, , , fourth, fifth] = list
      await writeMemory(user, fourth.id, { path: "keep.md", content: "mine", expectedVersion: null })
      await writeMemory(user, first.id, { path: "ok.md", content: "mine", expectedVersion: null })
      signInAs(user)
      asFree()

      // Nothing was deleted by the downgrade.
      expect(await countBots(user)).toBe(5)
      expect((await readMemory(user, fourth.id, "keep.md"))?.content).toBe("mine")

      // Not usable: no new chat, no memory changes.
      expect(await createChat(fourth.id)).toEqual({ error: READ_ONLY_BOT_MESSAGE })
      expect(
        await saveMemoryFile(fourth.id, { path: "keep.md", content: "changed", expectedVersion: 1 })
      ).toEqual({ error: READ_ONLY_BOT_MESSAGE })
      expect(await deleteMemoryFile(fourth.id, "keep.md")).toEqual({ error: READ_ONLY_BOT_MESSAGE })
      expect((await readMemory(user, fourth.id, "keep.md"))?.content).toBe("mine")

      // The bots the plan covers are untouched by any of this.
      expect(await createChat(first.id)).toHaveProperty("id")
      expect(
        await saveMemoryFile(first.id, { path: "ok.md", content: "changed", expectedVersion: 1 })
      ).toEqual({ path: "ok.md", version: 2 })

      // Deleting is allowed, and the oldest three stay the covered ones.
      expect(await removeBot(user, fifth.id, { provider: null })).toEqual({ ok: true })
      expect(await activeBotIds(user, "free")).toEqual([list[0].id, list[1].id, list[2].id])
      expect(await db.select().from(bots).where(eq(bots.id, fourth.id))).toHaveLength(1)
    })

    it("doesn't call someone else's bot read-only, or reveal that it exists", async () => {
      const user = newUser()
      const other = newUser()
      const theirs = await createTestBot(other)
      signInAs(user)
      asFree()

      expect(await createChat(theirs.id)).toEqual({ error: "That bot doesn't exist." })
      expect(
        await saveMemoryFile(theirs.id, { path: "x.md", content: "x", expectedVersion: null })
      ).toMatchObject({ error: "That memory file doesn't exist." })
    })
  })
})
